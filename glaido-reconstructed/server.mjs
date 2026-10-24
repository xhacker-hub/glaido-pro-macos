import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const DB_PATH = path.join(__dirname, "glaido-reconstructed.db");

const db = new DatabaseSync(DB_PATH);

// Remove any legacy demo sessions if present and ensure home_notes / home_chat tables exist
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS home_notes (
      id TEXT PRIMARY KEY,
      title TEXT,
      content TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS home_chat (
      id TEXT PRIMARY KEY,
      role TEXT,
      content TEXT,
      created_at TEXT
    );
  `);
  db.prepare("DELETE FROM entries WHERE session_id LIKE 'sess-ghidra%' OR session_id LIKE 'sess-sim%' OR session_id = 'sess-1792774422602'").run();
  db.prepare("DELETE FROM sessions WHERE id LIKE 'sess-ghidra%' OR id LIKE 'sess-sim%' OR id = 'sess-1792774422602'").run();
} catch {}

// SSE clients for real-time Tauri events across all open windows
const sseClients = new Set();
function broadcastTauriEvent(event, payload, target = null) {
  const msg = JSON.stringify({ event, payload, target, ts: Date.now() });
  for (const res of sseClients) {
    try {
      res.write(`data: ${msg}\n\n`);
    } catch {}
  }
}

let agentState = [
  {
    id: "claude",
    name: "Claude Code",
    appName: "Claude",
    status: "ready",
    connected: true,
    binarySource: "path",
    account: os.userInfo().username,
    plan: "Claude Max",
    installCommand: "npm install -g @anthropic-ai/claude-code",
    models: [
      { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
      { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" }
    ],
    reasoningLevels: ["low", "medium", "high"],
    config: {
      connected: true,
      enabled: true,
      permission: "full",
      model: "claude-opus-4-7",
      reasoning: "high",
      defaultProject: process.cwd(),
      askBeforeStart: false,
      showNotices: true
    }
  },
  {
    id: "codex",
    name: "Codex",
    appName: "Codex",
    status: "ready",
    connected: true,
    binarySource: "path",
    account: os.userInfo().username,
    plan: "Codex Pro",
    installCommand: "npm install -g @openai/codex",
    models: [
      { value: "gpt-5-codex", label: "GPT-5 Codex" },
      { value: "o4-mini", label: "o4-mini" }
    ],
    reasoningLevels: ["low", "medium", "high"],
    config: {
      connected: true,
      enabled: true,
      permission: "project",
      model: "gpt-5-codex",
      reasoning: "high",
      defaultProject: process.cwd(),
      askBeforeStart: true,
      showNotices: true
    }
  }
];

let agentTasks = [];

function getSettings() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'app_settings'").get();
  if (row?.value) {
    try {
      return JSON.parse(row.value);
    } catch {}
  }
  return {
    microphone_mode: "auto",
    preferred_microphone_reference: null,
    preferred_microphone_name: "MacBook Pro Microphone",
    auto_detect_include_bluetooth: true,
    show_virtual_microphones: false,
    selected_languages: ["en"],
    ui_language: "en",
    appearance: "dark",
    floating_controls_vertical_offset: 16,
    copy_to_clipboard: true,
    mute_background: true,
    interaction_sounds: true,
    launch_at_login: true,
    show_in_topbar: true,
    show_in_dock: true,
    beta_features_enabled: true,
    hotkeys: {
      push_to_talk: { primary_keycode: 63, primary_is_modifier: true, required_flags: 0, required_device_flags: 0, activation: "press" },
      persistent: { primary_keycode: 63, primary_is_modifier: true, required_flags: 0, required_device_flags: 0, activation: "double_tap_toggle" },
      command: { primary_keycode: 61, primary_is_modifier: true, required_flags: 0, required_device_flags: 0, activation: "press" },
      persistent_command: { primary_keycode: 61, primary_is_modifier: true, required_flags: 0, required_device_flags: 0, activation: "double_tap_toggle" },
      enter_to_paste: true
    }
  };
}

function saveSettings(newSettings) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('app_settings', ?)").run(JSON.stringify(newSettings));
  broadcastTauriEvent("settings-changed", newSettings);
  return newSettings;
}

function getSessionWithEntries(sessionRow) {
  const entries = db.prepare("SELECT * FROM entries WHERE session_id = ? ORDER BY created_at ASC").all(sessionRow.id).map(e => ({
    id: e.id,
    session_id: e.session_id,
    role: e.role || "user",
    content: e.content,
    raw_content: e.raw_content,
    audio_path: e.audio_path,
    is_error: Boolean(e.is_error),
    created_at: e.created_at,
    context: e.context_json ? JSON.parse(e.context_json) : null
  }));
  return {
    session: {
      id: sessionRow.id,
      mode: sessionRow.mode || "transcription",
      status: sessionRow.status || "completed",
      app_bundle_id: sessionRow.app_bundle_id,
      app_name: sessionRow.app_name,
      app_icon_path: sessionRow.app_icon_path,
      selected_text: sessionRow.selected_text,
      created_at: sessionRow.created_at,
      updated_at: sessionRow.updated_at
    },
    entries
  };
}

function getMcpSnapshot() {
  const servers = db.prepare("SELECT * FROM mcp_servers ORDER BY created_at ASC").all().map(s => ({
    id: s.id,
    name: s.name,
    command: s.command,
    args: JSON.parse(s.args_json || "[]"),
    working_directory: s.working_directory,
    env: JSON.parse(s.env_json || "{}"),
    status: s.status || "connected",
    approval_required: Boolean(s.approval_required),
    tool_approval: JSON.parse(s.tool_approval_json || "{}"),
    server_type: s.server_type || "stdio",
    read_only: Boolean(s.read_only),
    unsupported_reason: s.unsupported_reason,
    instructions: s.instructions
  }));
  const tools = db.prepare("SELECT * FROM mcp_tools ORDER BY name ASC").all().map(t => ({
    server_id: t.server_id,
    server_name: t.server_name,
    name: t.name,
    chat_name: t.chat_name,
    title: t.title || t.name,
    description: t.description || "",
    input_schema: JSON.parse(t.input_schema_json || "{}"),
    annotations: JSON.parse(t.annotations_json || "{}"),
    enabled: Boolean(t.enabled)
  }));
  return { servers, tools };
}

function getFormattingRules() {
  return db.prepare("SELECT * FROM formatting_rules ORDER BY sort_order ASC, created_at ASC").all().map(r => ({
    id: r.id,
    name: r.name,
    target: JSON.parse(r.target_json || '{"kind":"default"}'),
    mode: r.mode || "ai",
    style: r.style || "casual",
    custom_prompt: r.custom_prompt || "",
    enabled: Boolean(r.enabled),
    sort_order: r.sort_order ?? 0,
    created_at: r.created_at,
    updated_at: r.updated_at
  }));
}

function countWords(str) {
  if (!str || !str.trim()) return 0;
  return str.trim().split(/\s+/).length;
}

function computeAnalytics() {
  const sessions = db.prepare("SELECT * FROM sessions").all();
  const entries = db.prepare("SELECT * FROM entries WHERE role = 'user'").all();
  const todayIso = new Date().toISOString().slice(0, 10);
  const weekAgoDate = new Date();
  weekAgoDate.setDate(weekAgoDate.getDate() - 7);
  const weekAgoIso = weekAgoDate.toISOString().slice(0, 10);

  let totalWords = 0;
  let todayWords = 0;
  let weekWords = 0;
  for (const e of entries) {
    const w = countWords(e.content);
    totalWords += w;
    const d = (e.created_at || "").slice(0, 10);
    if (d === todayIso) todayWords += w;
    if (d >= weekAgoIso) weekWords += w;
  }

  const distinctDays = Array.from(new Set(sessions.map(s => (s.created_at || "").slice(0, 10)).filter(Boolean))).sort();
  const activeDaysTotal = distinctDays.length;
  let bestStreak = activeDaysTotal > 0 ? 1 : 0;
  let currentStreak = activeDaysTotal > 0 ? 1 : 0;
  let streak = 1;
  for (let i = 1; i < distinctDays.length; i++) {
    const prev = new Date(distinctDays[i - 1]);
    const curr = new Date(distinctDays[i]);
    const diffDays = Math.round((curr - prev) / 86400000);
    if (diffDays === 1) {
      streak++;
      if (streak > bestStreak) bestStreak = streak;
    } else {
      streak = 1;
    }
  }
  currentStreak = streak;

  const commandSessions = sessions.filter(s => s.mode === "command").length;
  const speechTotalMs = Math.max(1000, Math.round((totalWords / 150) * 60000));
  const wpm = totalWords > 0 ? Math.min(220, Math.max(110, Math.round(totalWords / Math.max(1, speechTotalMs / 60000)))) : 0;
  const timeSavedMinutes = Math.max(0, Math.round(totalWords / 40 - totalWords / 150));

  return {
    words_count: {
      totals_usage: totalWords,
      today: todayWords,
      this_week: weekWords
    },
    duration: {
      speech_total_ms: speechTotalMs,
      non_empty_total_ms: speechTotalMs,
      seconds: Math.round(speechTotalMs / 1000)
    },
    speech_total_ms: speechTotalMs,
    productivity: {
      words_per_minute: wpm,
      time_saved_minutes: timeSavedMinutes
    },
    engagement: {
      current_day_streak: currentStreak,
      best_day_streak: bestStreak,
      active_days_total: activeDaysTotal
    },
    sessions: {
      total: sessions.length
    },
    quality: {
      command_usage_rate: sessions.length ? commandSessions / sessions.length : 0
    }
  };
}

function computeAnalyticsDaily() {
  const rows = db.prepare(`
    SELECT substr(s.created_at, 1, 10) AS day,
           count(DISTINCT s.id) AS session_count,
           COALESCE(group_concat(e.content, ' '), '') AS combined_text
    FROM sessions s
    LEFT JOIN entries e ON e.session_id = s.id AND e.role = 'user'
    GROUP BY day
  `).all();
  const byDay = new Map();
  for (const r of rows) {
    if (!r.day) continue;
    const words = countWords(r.combined_text);
    byDay.set(r.day, {
      words,
      sessions: Number(r.session_count) || 0,
      speech_ms: Math.round((words / 150) * 60000)
    });
  }
  const days = [];
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const stat = byDay.get(iso) || { words: 0, sessions: 0, speech_ms: 0 };
    days.push({
      date: iso,
      words: stat.words,
      sessions: stat.sessions,
      speech_ms: stat.speech_ms
    });
  }
  return days;
}

function computeDeviceAnalytics() {
  const rows = db.prepare(`
    SELECT s.app_bundle_id,
           s.app_name,
           s.app_icon_path,
           count(DISTINCT s.id) AS session_count,
           COALESCE(group_concat(e.content, ' '), '') AS combined_text
    FROM sessions s
    LEFT JOIN entries e ON e.session_id = s.id AND e.role = 'user'
    WHERE s.app_bundle_id IS NOT NULL AND s.app_bundle_id != ''
    GROUP BY s.app_bundle_id
    ORDER BY session_count DESC
  `).all();
  return {
    apps: rows.map(r => {
      const words = countWords(r.combined_text);
      const appName = r.app_name || r.app_bundle_id;
      return {
        bundle_id: r.app_bundle_id,
        app_name: appName,
        name: appName,
        icon_path: r.app_icon_path || `/app-icons/${r.app_bundle_id}.png`,
        words,
        sessions: Number(r.session_count) || 0,
        duration_ms: Math.round((words / 150) * 60000)
      };
    })
  };
}

async function handleTauriInvoke(cmd, args = {}) {
  switch (cmd) {
    case "__emit_event": {
      const target = typeof args.target === "string"
        ? args.target
        : (args.target && typeof args.target.label === "string" ? args.target.label : null);
      broadcastTauriEvent(args.event || "", args.payload ?? null, target);
      return null;
    }
    case "get_auth_status":
    case "sign_in":
    case "begin_reauth":
    case "complete_welcome":
    case "complete_onboarding":
      return {
        is_authenticated: true,
        has_completed_welcome: true,
        has_completed_onboarding: true,
        account_id: "usr-local-pro",
        email: "pranav@local.glaido",
        first_name: "Pranav",
        last_name: "Goel",
        user: {
          id: "usr-local-pro",
          email: "pranav@local.glaido",
          name: "Pranav Goel"
        }
      };

    case "mark_onboarding_reached_tryit":
      return { hotkey_listener_ready: true };

    case "warm_keychain":
    case "send_magic_link":
    case "sign_out":
    case "reset_onboarding":
    case "sync_dictionary":
    case "sync_snippets":
      return true;

    case "get_settings":
    case "sync_settings_from_backend":
      return getSettings();

    case "update_settings_intent": {
      const current = getSettings();
      const intent = args.intent || {};
      if (intent.type === "select_auto_microphone") {
        current.microphone_mode = "auto";
        current.preferred_microphone_reference = null;
        current.preferred_microphone_name = null;
      }
      if (intent.type === "select_static_microphone") {
        current.microphone_mode = "static";
        current.preferred_microphone_reference = intent.reference || null;
        current.preferred_microphone_name = intent.name || null;
      }
      if (intent.type === "set_appearance") current.appearance = intent.appearance;
      if (intent.type === "set_ui_language") current.ui_language = intent.language;
      if (intent.type === "set_microphone_mode") current.microphone_mode = intent.mode;
      if (intent.type === "set_preferred_microphone") {
        current.preferred_microphone_name = intent.name;
        current.preferred_microphone_reference = intent.reference;
      }
      if (intent.type === "set_auto_detect_include_bluetooth") current.auto_detect_include_bluetooth = intent.enabled;
      if (intent.type === "set_show_virtual_microphones") current.show_virtual_microphones = intent.enabled;
      if (intent.type === "set_selected_languages") current.selected_languages = intent.languages;
      if (intent.type === "set_floating_controls_vertical_offset") current.floating_controls_vertical_offset = intent.offset;
      if (intent.type === "set_boolean_preference" && intent.key) current[intent.key] = intent.enabled;
      if (intent.type === "set_copy_to_clipboard") current.copy_to_clipboard = intent.enabled;
      if (intent.type === "set_mute_background") current.mute_background = intent.enabled;
      if (intent.type === "set_interaction_sounds") current.interaction_sounds = intent.enabled;
      if (intent.type === "set_launch_at_login") current.launch_at_login = intent.enabled;
      if (intent.type === "set_show_in_topbar") current.show_in_topbar = intent.enabled;
      if (intent.type === "set_show_in_dock") current.show_in_dock = intent.enabled;
      if (intent.type === "set_beta_features_enabled") current.beta_features_enabled = intent.enabled;
      if (intent.type === "set_hotkey" && current.hotkeys && intent.slot) {
        current.hotkeys[intent.slot] = intent.binding;
      }
      if (intent.type === "reassign_hotkey" && current.hotkeys && intent.to) {
        if (intent.from && intent.from !== intent.to) current.hotkeys[intent.from] = null;
        current.hotkeys[intent.to] = intent.binding;
      }
      if (intent.type === "set_enter_to_paste" && current.hotkeys) current.hotkeys.enter_to_paste = intent.enabled;
      return saveSettings(current);
    }

    case "check_permissions":
    case "get_permissions_status":
      return { microphone: true, accessibility: true, speech_recognition: true };

    case "request_microphone_permission":
    case "request_accessibility_permission":
      return true;

    case "get_subscription_info":
    case "resubscribe": {
      const stats = computeAnalytics();
      return {
        subscription: {
          plan: "pro",
          status: "active",
          current_period_end: "2099-12-31T23:59:59Z"
        },
        plan: {
          account_type: "pro",
          is_valid: true,
          billing_model: "individual",
          cancel_at_period_end: false,
          is_organization_owner: true,
          referral_trial_available: false
        },
        usage: {
          words_used: stats.words_count.totals_usage,
          words_limit: null,
          reset_at: null
        }
      };
    }

    case "get_history": {
      const page = Math.max(1, Number(args.page) || 1);
      const limit = Math.max(1, Number(args.limit) || 25);
      const offset = (page - 1) * limit;
      const rows = db.prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
      const total = db.prepare("SELECT count(*) as c FROM sessions").get().c;
      return {
        sessions: rows.map(getSessionWithEntries),
        pagination: {
          page,
          limit,
          total,
          has_more: offset + rows.length < total
        }
      };
    }

    case "get_session_detail": {
      const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(args.sessionId);
      return row ? getSessionWithEntries(row) : null;
    }

    case "search_transcripts": {
      const q = `%${(args.query || "").trim()}%`;
      const rows = db.prepare(`
        SELECT DISTINCT s.* FROM sessions s
        JOIN entries e ON e.session_id = s.id
        WHERE e.content LIKE ? OR s.app_name LIKE ?
        ORDER BY s.created_at DESC LIMIT 50
      `).all(q, q);
      return rows.map(getSessionWithEntries);
    }

    case "delete_history_session":
      db.prepare("DELETE FROM entries WHERE session_id = ?").run(args.sessionId);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(args.sessionId);
      broadcastTauriEvent("history-updated", {});
      return true;

    case "delete_all_history":
      db.prepare("DELETE FROM entries").run();
      db.prepare("DELETE FROM sessions").run();
      broadcastTauriEvent("history-updated", {});
      return true;

    case "get_audio_data": {
      const rel = args.audioPath || "";
      const candidate = path.isAbsolute(rel) ? rel : path.join(PUBLIC_DIR, rel);
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate).toString("base64");
      }
      return "";
    }

    case "download_audio": {
      const rel = args.audioPath || args.audio_path || "";
      const filename = path.basename(rel || "session.wav") || "session.wav";
      const src = path.isAbsolute(rel) && fs.existsSync(rel) ? rel : path.join(PUBLIC_DIR, rel);
      const downloadsDir = path.join(os.homedir(), "Downloads");
      const dest = path.join(downloadsDir, filename);
      try {
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dest);
          return dest;
        }
      } catch {}
      return true;
    }

    case "retranscribe_session": {
      const sid = args.sessionId || args.session_id || args.id || "";
      if (!sid) return null;
      const now = new Date().toISOString();
      db.prepare("UPDATE entries SET is_error = 0 WHERE session_id = ? AND role = 'user'").run(sid);
      db.prepare("UPDATE sessions SET status = 'completed', updated_at = ? WHERE id = ?").run(now, sid);
      broadcastTauriEvent("history-updated", {});
      const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sid);
      return row ? getSessionWithEntries(row) : null;
    }

    case "get_dictionary":
      return db.prepare("SELECT * FROM dictionary ORDER BY word COLLATE NOCASE ASC").all().map(d => ({
        id: d.id,
        word: d.word,
        predecessor: d.predecessor,
        misspellings: JSON.parse(d.misspellings_json || "[]"),
        created_at: d.created_at,
        updated_at: d.updated_at
      }));

    case "save_dictionary_term": {
      const id = `dict-${Date.now()}`;
      const now = new Date().toISOString();
      const misspellings = Array.isArray(args.misspellings) ? args.misspellings : [];
      const term = {
        id,
        word: args.word,
        predecessor: null,
        misspellings,
        created_at: now,
        updated_at: now
      };
      db.prepare("INSERT INTO dictionary (id, word, predecessor, misspellings_json, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)")
        .run(id, term.word, JSON.stringify(term.misspellings), now, now);
      return { outcome: "created", added: misspellings.length, term };
    }

    case "update_dictionary_term": {
      const now = new Date().toISOString();
      db.prepare("UPDATE dictionary SET word = ?, misspellings_json = ?, updated_at = ? WHERE id = ?")
        .run(args.word, JSON.stringify(args.misspellings || []), now, args.id);
      return true;
    }

    case "delete_dictionary_term":
      db.prepare("DELETE FROM dictionary WHERE id = ?").run(args.id);
      return true;

    case "delete_all_dictionary_terms":
      db.prepare("DELETE FROM dictionary").run();
      return true;

    case "accept_correction_suggestion":
      return { action: "accepted", entry: null };

    case "get_snippets":
      return db.prepare("SELECT * FROM snippets ORDER BY trigger COLLATE NOCASE ASC").all();

    case "add_snippet": {
      const id = `snip-${Date.now()}`;
      const now = new Date().toISOString();
      db.prepare("INSERT INTO snippets (id, trigger, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, args.trigger, args.content, now, now);
      return { id, trigger: args.trigger, content: args.content, created_at: now, updated_at: now };
    }

    case "edit_snippet": {
      const now = new Date().toISOString();
      db.prepare("UPDATE snippets SET trigger = ?, content = ?, updated_at = ? WHERE id = ?")
        .run(args.trigger, args.content, now, args.id);
      return true;
    }

    case "delete_snippet":
      db.prepare("DELETE FROM snippets WHERE id = ?").run(args.id);
      return true;

    case "get_dynamic_tag_previews": {
      const now = new Date();
      const dateStr = now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      return {
        "{gl.clipboard}": "",
        "{gl.datetime}": `${dateStr}, ${timeStr}`,
        "{gl.timezone}": tzName,
        date: dateStr,
        time: timeStr,
        day: now.toLocaleDateString("en-US", { weekday: "long" }),
        clipboard: ""
      };
    }

    case "get_formatting_rules":
      return getFormattingRules();

    case "get_formatting_place_options": {
      const appRows = db.prepare(`
        SELECT app_bundle_id, app_name, count(*) AS uses, max(created_at) AS last_used_at
        FROM sessions
        WHERE app_bundle_id IS NOT NULL AND app_bundle_id != ''
        GROUP BY app_bundle_id
        ORDER BY uses DESC
      `).all();
      return {
        apps: appRows.map(r => ({
          identity: { platform: "macos", kind: "bundle_id", value: r.app_bundle_id },
          name: r.app_name || r.app_bundle_id,
          uses: Number(r.uses) || 1,
          last_used_at: r.last_used_at || new Date().toISOString()
        })),
        sites: []
      };
    }

    case "get_installed_app_options":
      return [];

    case "add_formatting_rule": {
      const d = args.draft || {};
      const id = `rule-${Date.now()}`;
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO formatting_rules (id, name, target_json, mode, style, custom_prompt, enabled, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 10, ?, ?)
      `).run(id, d.name || "Custom Rule", JSON.stringify(d.target || { kind: "default" }), d.mode || "ai", d.style || "casual", d.custom_prompt || "", d.enabled === false ? 0 : 1, now, now);
      return getFormattingRules();
    }

    case "edit_formatting_rule": {
      const d = args.draft || {};
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE formatting_rules
        SET name = ?, target_json = ?, mode = ?, style = ?, custom_prompt = ?, enabled = ?, updated_at = ?
        WHERE id = ?
      `).run(d.name, JSON.stringify(d.target || { kind: "default" }), d.mode || "ai", d.style || "casual", d.custom_prompt || "", d.enabled === false ? 0 : 1, now, args.id);
      return getFormattingRules();
    }

    case "delete_formatting_rule":
      db.prepare("DELETE FROM formatting_rules WHERE id = ?").run(args.id);
      return getFormattingRules();

    case "list_mcp_servers":
    case "reload_mcp_config":
    case "refresh_mcp_server_tools":
    case "import_mcp_config_folder":
    case "save_mcp_server":
    case "delete_mcp_server":
    case "update_mcp_tool_enabled":
    case "update_mcp_tool_approval_policy":
      return getMcpSnapshot();

    case "get_mcp_config_path":
      return path.join(os.homedir(), ".gemini", "config", "mcp_config.json");

    case "glaido_servers_root":
    case "pick_glaido_servers_root":
      return process.cwd();

    case "probe_server_runtime":
      return {
        installations: [{ path: process.execPath, version: process.version }],
        install_command: "brew install node"
      };

    case "scaffold_mcp_server":
      return {
        id: `mcp-${Date.now()}`,
        folder: path.join(process.cwd(), args.name || "custom-server"),
        handoff_prompt: ""
      };

    case "get_api_builtin_inventory":
      return {
        builtins: [
          { server: "web", name: "web_search", title: "Web search", description: "Finds pages and reads the top few", runs_on: "api", available: true, enabled: true },
          { server: "web", name: "fetch_url", title: "Read a page", description: "Reads the one page you point it at", runs_on: "api", available: true, enabled: true },
          { server: "web", name: "youtube_summary", title: "Summarize a YouTube video", description: "Works from the video's transcript", runs_on: "api", available: true, enabled: true },
          { server: "web", name: "deep_research", title: "Deep research", description: "Reads across many sources, and takes minutes", runs_on: "api", available: true, enabled: true },
          { server: "system", name: "utilities", title: "Math and dates", description: "Calculator, time zones, and date questions", runs_on: "api", available: true, enabled: true },
          { server: "system", name: "find_read_open", title: "Files and apps", description: "Lists, finds, reads, and opens files, folders, and apps", runs_on: "api", available: true, enabled: true },
          { server: "system", name: "clipboard_history", title: "Search clipboard history", description: "Finds text, files, and images you copied earlier today", runs_on: "api", available: true, enabled: true },
          { server: "glaido", name: "analyze_image", title: "Analyze image", description: "Shows you the copied picture before using it", runs_on: "api", available: true, enabled: true },
          { server: "glaido", name: "search_history", title: "Search your history", description: "Finds anything you have dictated on this Mac", runs_on: "api", available: true, enabled: true },
          { server: "glaido", name: "search_docs", title: "Search documentation", description: "Answers a question about Glaido itself", runs_on: "api", available: true, enabled: true }
        ]
      };

    case "get_home_notes":
    case "list_home_notes":
      return db.prepare("SELECT * FROM home_notes ORDER BY updated_at DESC").all();

    case "create_home_note":
    case "update_home_note":
    case "save_home_note": {
      const now = new Date().toISOString();
      const id = args.id || `note-${Date.now()}`;
      const title = args.title || "";
      const content = args.content || "";
      const existing = db.prepare("SELECT created_at FROM home_notes WHERE id = ?").get(id);
      const createdAt = existing?.created_at || now;
      db.prepare(`
        INSERT OR REPLACE INTO home_notes (id, title, content, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, title, content, createdAt, now);
      return {
        id,
        title,
        content,
        created_at: createdAt,
        updated_at: now
      };
    }

    case "delete_home_note":
      db.prepare("DELETE FROM home_notes WHERE id = ?").run(args.id || "");
      return true;

    case "clear_home_chat":
      db.prepare("DELETE FROM home_chat").run();
      return { messages: [] };

    case "get_home_chat_state":
    case "get_home_chat":
      return {
        messages: db.prepare("SELECT * FROM home_chat ORDER BY created_at ASC").all()
      };

    case "send_home_chat_message":
    case "send_home_chat": {
      const msg = args.message || args.text || args.prompt || "";
      const now = new Date().toISOString();
      const userId = `msg-${Date.now()}-1`;
      const asstId = `msg-${Date.now()}-2`;
      db.prepare("INSERT INTO home_chat (id, role, content, created_at) VALUES (?, 'user', ?, ?)").run(userId, msg, now);
      db.prepare("INSERT INTO home_chat (id, role, content, created_at) VALUES (?, 'assistant', ?, ?)").run(asstId, `Processed: ${msg}`, now);
      return {
        messages: db.prepare("SELECT * FROM home_chat ORDER BY created_at ASC").all()
      };
    }

    case "get_agents":
    case "refresh_agents":
    case "get_agents_list":
      return agentState;

    case "connect_agent":
    case "disconnect_agent":
    case "update_agent_config":
    case "update_agent_state": {
      const targetId = args.agent || args.id || "claude";
      const found = agentState.find(a => a.id === targetId) || agentState[0];
      if (cmd === "connect_agent") {
        found.connected = true;
        found.config.connected = true;
      } else if (cmd === "disconnect_agent") {
        found.connected = false;
        found.config.connected = false;
      } else {
        if (typeof args.connected === "boolean") {
          found.connected = args.connected;
          found.config.connected = args.connected;
        }
        if (args.patch || args.config) {
          Object.assign(found.config, args.patch || args.config);
        }
      }
      broadcastTauriEvent("agents-changed", agentState);
      return found;
    }

    case "sign_in_agent":
    case "install_agent":
      return true;

    case "get_agent_tasks":
      return agentTasks;

    case "get_agent_projects":
      return [
        { name: path.basename(process.cwd()), path: process.cwd(), lastUsedMs: Date.now() }
      ];

    case "pick_agent_project_folder":
      return process.cwd();

    case "get_agent_task_run_options":
    case "set_agent_task_run":
      return {
        models: [
          { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
          { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
          { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" }
        ],
        reasoningLevels: ["low", "medium", "high"]
      };

    case "get_analytics":
      return computeAnalytics();

    case "get_analytics_daily":
      return computeAnalyticsDaily();

    case "get_device_analytics":
      return computeDeviceAnalytics();

    case "get_analytics_rank": {
      const stats = computeAnalytics();
      const wpm = stats.productivity.words_per_minute;
      const totalWords = stats.words_count.totals_usage;
      const percentile = wpm >= 140 ? 95 : 80;
      const shares = [
        0.14, 0.12, 0.11, 0.10, 0.09,
        0.08, 0.07, 0.06, 0.05, 0.04,
        0.03, 0.025, 0.02, 0.018, 0.014,
        0.011, 0.008, 0.006, 0.005, 0.003
      ];
      const bins = shares.map((share, i) => ({
        lo: i * 1500,
        hi: i === 19 ? null : (i + 1) * 1500,
        share
      }));
      return {
        percentile,
        top_percent: Math.max(1, 100 - percentile),
        tier: wpm >= 140 ? "top_5_percent" : "top_20_percent",
        words_per_minute: wpm,
        words: totalWords,
        you: Math.min(0.96, Math.max(0.08, percentile / 100)),
        bins
      };
    }

    case "get_microphone_list":
      return [
        {
          id: "built-in-mic",
          name: "MacBook Pro Microphone",
          reference: { uid: "built-in-mic", name: "MacBook Pro Microphone" },
          is_default: true,
          is_available: true,
          is_virtual: false,
          is_bluetooth: false
        }
      ];

    case "get_auto_detect_microphone_name":
      return "MacBook Pro Microphone";

    case "get_binding_display": {
      const b = args.binding || {};
      const code = typeof b.primary_keycode === "number" ? b.primary_keycode : 63;
      const keyMap = {
        63: "fn", 61: "Right ⌥", 58: "Left ⌥", 54: "Right ⌘", 55: "Left ⌘",
        56: "Left ⇧", 60: "Right ⇧", 59: "Left ⌃", 62: "Right ⌃", 57: "Caps Lock",
        0: "A", 1: "S", 2: "D", 3: "F", 4: "H", 5: "G", 6: "Z", 7: "X", 8: "C", 9: "V",
        10: "§", 11: "B", 12: "Q", 13: "W", 14: "E", 15: "R", 16: "Y", 17: "T",
        18: "1", 19: "2", 20: "3", 21: "4", 22: "6", 23: "5", 24: "=", 25: "9",
        26: "7", 27: "-", 28: "8", 29: "0", 30: "]", 31: "O", 32: "U", 33: "[",
        34: "I", 35: "P", 36: "Return", 37: "L", 38: "J", 39: "'", 40: "K", 41: ";",
        42: "\\", 43: ",", 44: "/", 45: "N", 46: "M", 47: ".", 48: "Tab", 49: "Space",
        50: "`", 51: "Delete", 53: "Escape",
        64: "F17", 65: "Keypad .", 67: "Keypad *", 69: "Keypad +", 71: "Clear",
        75: "Keypad /", 76: "Enter", 78: "Keypad -", 79: "F18", 80: "F19", 81: "Keypad =",
        82: "Keypad 0", 83: "Keypad 1", 84: "Keypad 2", 85: "Keypad 3", 86: "Keypad 4",
        87: "Keypad 5", 88: "Keypad 6", 89: "Keypad 7", 90: "F20", 91: "Keypad 8", 92: "Keypad 9",
        96: "F5", 97: "F6", 98: "F7", 99: "F3", 100: "F8", 101: "F9", 103: "F11",
        105: "F13", 106: "F16", 107: "F14", 109: "F10", 111: "F12", 113: "F15",
        114: "Help", 115: "Home", 116: "Page Up", 117: "Forward Delete", 118: "F4",
        119: "End", 120: "F2", 121: "Page Down", 122: "F1",
        123: "←", 124: "→", 125: "↓", 126: "↑"
      };
      const ownFlags = {
        63: 0x800000, 58: 0x80000, 61: 0x80000, 54: 0x100000, 55: 0x100000,
        56: 0x20000, 60: 0x20000, 59: 0x40000, 62: 0x40000, 57: 0x10000
      };
      const isMod = Boolean(b.primary_is_modifier ?? (code in ownFlags));
      const ownFlag = isMod ? (ownFlags[code] || 0) : 0;
      const reqFlags = ((b.required_flags || 0) & ~ownFlag);
      const mods = [];
      if ((reqFlags & 0x800000) !== 0 && code !== 63) mods.push("fn");
      if ((reqFlags & 0x40000) !== 0) mods.push("⌃");
      if ((reqFlags & 0x80000) !== 0) mods.push("⌥");
      if ((reqFlags & 0x20000) !== 0) mods.push("⇧");
      if ((reqFlags & 0x100000) !== 0) mods.push("⌘");
      return [keyMap[code] || `Key ${code}`, mods];
    }

    case "get_binding_advisory":
      return null;

    case "check_wisprflow_available":
      return { available: false, dictionary_count: 0, snippets_count: 0 };

    case "get_wisprflow_preview":
      return { dictionary: [], snippets: [] };

    case "import_wisprflow":
      return { dictionary_imported: 0, snippets_imported: 0, dictionary_skipped_full: 0 };

    case "get_referral_code":
      return { code: "GLAIDO-PRO", link: "https://glaido.com/r/GLAIDO-PRO" };

    case "get_referrals":
      return [];

    case "send_invite":
      return true;

    case "get_feedback_environment":
      return { os: "macOS", arch: "arm64", version: "0.4.4" };

    case "submit_feedback":
      return { ok: true };

    case "check_for_updates_now":
      return { status: "up_to_date", version: "0.4.4" };

    case "get_overlay_visual_state":
      return { phase: "idle", mode: "dictation", amplitude: 0, persistent: false };

    case "plugin:app|version":
      return "0.4.4";

    case "plugin:window|get_all_windows":
      return ["main", "command-modal", "overlay", "toast-overlay"];

    case "get_recovery_error":
      throw new Error("Not in recovery mode");

    case "take_open_screen":
    case "get_hotkey_focused_input_native":
    case "get_media_artwork":
    case "get_provider_app_icon":
      return null;

    default:
      return true;
  }
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
};

function renderAppIconSvg(name) {
  const label = path.basename(name, ".png").split(".").pop().slice(0, 2).toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <rect width="64" height="64" rx="14" fill="#18181B"/>
    <rect x="2" y="2" width="60" height="60" rx="12" fill="none" stroke="#BFF549" stroke-opacity="0.35" stroke-width="2"/>
    <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" fill="#BFF549" font-family="-apple-system, sans-serif" font-size="22" font-weight="700">${label}</text>
  </svg>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/__tauri_events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });
    res.write(`data: ${JSON.stringify({ event: "connected", payload: true })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (url.pathname === "/__tauri_emit" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { event, payload, target } = JSON.parse(body || "{}");
    broadcastTauriEvent(event, payload, target);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if ((url.pathname === "/__tauri_invoke" || url.pathname === "/api/invoke") && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const { cmd, args } = JSON.parse(body || "{}");
      const result = await handleTauriInvoke(cmd, args);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, result, data: result }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: { kind: "system", code: "internal", message: String(err?.message || err) } }));
    }
    return;
  }

  if (url.pathname.startsWith("/app-icons/")) {
    res.writeHead(200, { "Content-Type": "image/svg+xml" });
    res.end(renderAppIconSvg(url.pathname));
    return;
  }

  let filePath = path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, "index.html");
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(filePath).pipe(res);
});

const PORT = Number(process.env.PORT || process.env.GLAIDO_PORT) || 4173;
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[Glaido Local Server] Listening on http://127.0.0.1:${PORT}`);
});
