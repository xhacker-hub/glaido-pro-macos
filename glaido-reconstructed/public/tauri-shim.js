(function () {
  if (window.__GLAIDO_TAURI_SHIM_INITIALIZED__) {
    return;
  }
  window.__GLAIDO_TAURI_SHIM_INITIALIZED__ = true;

  const initialPath = window.location.pathname || "/";
  if (
    initialPath === "/signin" ||
    initialPath === "/welcome" ||
    initialPath === "/onboarding" ||
    initialPath.startsWith("/signin/") ||
    initialPath.startsWith("/welcome/") ||
    initialPath.startsWith("/onboarding/")
  ) {
    try {
      window.history.replaceState(null, "", "/");
    } catch {}
  }

  const path = window.location.pathname || "/";
  const currentLabel =
    typeof window.__GLAIDO_WINDOW_LABEL__ === "string" && window.__GLAIDO_WINDOW_LABEL__
      ? window.__GLAIDO_WINDOW_LABEL__
      : path.includes("command-modal")
      ? "command-modal"
      : path.includes("overlay") && !path.includes("toast")
      ? "overlay"
      : path.includes("toast-overlay")
      ? "toast-overlay"
      : "main";

  const OFFLINE_AUTH_STATUS = {
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

  const OFFLINE_SUBSCRIPTION_INFO = {
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
      words_used: 0,
      words_limit: null,
      reset_at: null
    }
  };

  let nextCallbackId = 1;
  const callbacks = new Map();
  const eventListeners = new Map(); // eventName -> Set<{ id, handlerId }>

  function dispatchTauriEvent(event, payload) {
    const set = eventListeners.get(event);
    if (!set) return;
    // Normalize 0.0..1.0 native RMS amplitude to 0..100 for Glaido's waveform UI components
    const normalizedPayload =
      event === "amplitude-update" &&
      typeof payload === "number" &&
      payload >= 0 &&
      payload <= 1.0
        ? Math.round(payload * 100)
        : payload;
    for (const item of Array.from(set)) {
      const cb = callbacks.get(item.handlerId);
      if (cb) {
        try {
          let effectivePayload = normalizedPayload;
          if (
            event === "transcription-final" &&
            normalizedPayload &&
            typeof normalizedPayload === "object" &&
            typeof normalizedPayload.text === "string"
          ) {
            const cbStr = String(cb.__rawCallback || cb);
            if (cbStr.includes("p(!1),f(0),v(null)")) {
              effectivePayload = normalizedPayload.text;
            }
          }
          cb({ event, id: item.id, payload: effectivePayload });
        } catch (err) {
          console.error("[TauriShim] Listener error:", err);
        }
      }
    }
  }

  // Expose native event dispatcher for WKWebView evaluateJavaScript calls from Swift
  window.__GLAIDO_DISPATCH_EVENT__ = function (event, payload) {
    dispatchTauriEvent(event, payload);
  };

  const getNativeHandler = () => {
    if (
      typeof window.webkit !== "undefined" &&
      window.webkit &&
      window.webkit.messageHandlers
    ) {
      return (
        window.webkit.messageHandlers.glaidoNative ||
        window.webkit.messageHandlers.glaidoIPC ||
        null
      );
    }
    return null;
  };

  const hasNativeBridge = () => Boolean(getNativeHandler());

  function normalizeEventTarget(target) {
    if (!target) return null;
    if (typeof target === "string") return target;
    if (typeof target === "object" && typeof target.label === "string") {
      return target.label;
    }
    return null;
  }

  async function rawBackendCall(cmd, args) {
    const handler = getNativeHandler();
    if (handler) {
      const normalizedTarget = normalizeEventTarget(args?.target);
      const payload =
        cmd === "__emit_event"
          ? {
              kind: "emit",
              cmd,
              event: args?.event || "",
              payload: args?.payload ?? null,
              target: normalizedTarget,
              args: { ...(args || {}), target: normalizedTarget },
              windowLabel: currentLabel
            }
          : {
              kind: "invoke",
              cmd,
              args: args || {},
              windowLabel: currentLabel
            };
      const res = await handler.postMessage(payload);
      if (res && res.ok === false) {
        throw res.error || { kind: "system", code: "internal", message: "Native IPC error" };
      }
      return res ? (res.result !== undefined ? res.result : res.data) : null;
    } else {
      const resp = await fetch("/__tauri_invoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd, args })
      });
      const data = await resp.json();
      if (!data.ok) throw data.error;
      return data.result !== undefined ? data.result : data.data;
    }
  }

  async function callBackend(cmd, args) {
    // CRITICAL: In Glaido's root component cP(), get_recovery_error MUST reject in normal mode.
    // If it resolves (even with null), cP() renders the Database Recovery Error screen instead of the app.
    if (cmd === "get_recovery_error") {
      throw { kind: "system", code: "not_in_recovery", message: "Normal mode" };
    }

    // Immediate offline auth & onboarding bypass guarantees
    if (
      cmd === "get_auth_status" ||
      cmd === "sign_in" ||
      cmd === "begin_reauth" ||
      cmd === "complete_welcome" ||
      cmd === "complete_onboarding"
    ) {
      rawBackendCall(cmd, args).catch(() => {});
      return OFFLINE_AUTH_STATUS;
    }

    if (cmd === "get_subscription_info" || cmd === "resubscribe") {
      try {
        const res = await rawBackendCall(cmd, args);
        if (res && res.plan && res.plan.is_valid) {
          return res;
        }
      } catch {}
      return OFFLINE_SUBSCRIPTION_INFO;
    }

    if (cmd === "mark_onboarding_reached_tryit") {
      rawBackendCall(cmd, args).catch(() => {});
      return { hotkey_listener_ready: true };
    }

    if (cmd === "check_permissions" || cmd === "get_permissions_status") {
      rawBackendCall(cmd, args).catch(() => {});
      return {
        microphone: true,
        accessibility: true,
        speech_recognition: true
      };
    }

    if (
      cmd === "warm_keychain" ||
      cmd === "send_magic_link" ||
      cmd === "sign_out" ||
      cmd === "reset_onboarding" ||
      cmd === "sync_dictionary" ||
      cmd === "sync_snippets"
    ) {
      rawBackendCall(cmd, args).catch(() => {});
      return true;
    }

    if (cmd === "sync_settings_from_backend") {
      return await rawBackendCall("get_settings", args);
    }

    return await rawBackendCall(cmd, args);
  }

  // Subscribe to SSE fallback only if not running inside native WKWebView
  if (!hasNativeBridge() && window.location.protocol.startsWith("http")) {
    try {
      const es = new EventSource("/__tauri_events");
      es.onmessage = ev => {
        try {
          const data = JSON.parse(ev.data);
          const targetLabel = normalizeEventTarget(data.target);
          if (!targetLabel || targetLabel === currentLabel) {
            dispatchTauriEvent(data.event, data.payload);
          }
        } catch {}
      };
    } catch {}
  }

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event, eventId) {
      const set = eventListeners.get(event);
      if (!set) return;
      for (const item of set) {
        if (item.id === eventId) set.delete(item);
      }
    }
  };

  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: currentLabel },
      currentWebview: { windowLabel: currentLabel, label: currentLabel }
    },
    transformCallback(callback, once = false) {
      const id = nextCallbackId++;
      const wrapped = function (...args) {
        if (once) callbacks.delete(id);
        return callback && callback(...args);
      };
      wrapped.__rawCallback = callback;
      callbacks.set(id, wrapped);
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    convertFileSrc(filePath, protocol = "asset") {
      if (!filePath) return "";
      if (
        filePath.startsWith("http") ||
        filePath.startsWith("data:") ||
        filePath.startsWith("app:") ||
        filePath.startsWith("/")
      ) {
        return filePath;
      }
      return `/${filePath}`;
    },
    async invoke(cmd, args = {}) {
      if (cmd === "plugin:event|listen") {
        const { event, handler } = args;
        const id = nextCallbackId++;
        if (!eventListeners.has(event)) eventListeners.set(event, new Set());
        eventListeners.get(event).add({ id, handlerId: handler });
        return id;
      }
      if (cmd === "plugin:event|unlisten") {
        const { event, eventId } = args;
        window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(event, eventId);
        return null;
      }
      if (cmd === "plugin:event|emit" || cmd === "plugin:event|emit_to") {
        const { event, payload, target } = args;
        const targetLabel = normalizeEventTarget(target);
        if (!hasNativeBridge() && (!targetLabel || targetLabel === currentLabel)) {
          dispatchTauriEvent(event, payload);
        }
        callBackend("__emit_event", { event, payload, target: targetLabel }).catch(() => {});
        return null;
      }
      if (cmd === "plugin:resources|close") {
        return null;
      }

      if (cmd.startsWith("plugin:window|")) {
        const sub = cmd.split("|")[1];
        if (sub === "theme") return "dark";
        if (sub === "scale_factor") return window.devicePixelRatio || 2;
        if (sub === "inner_size" || sub === "outer_size") return { width: window.innerWidth, height: window.innerHeight };
        if (sub === "inner_position" || sub === "outer_position") return { x: 80, y: 60 };
        if (sub === "get_all_windows") return ["main", "command-modal", "overlay", "toast-overlay"];
        if (sub === "hide" || sub === "close" || sub === "show" || sub === "set_focus" || sub === "start_dragging" || sub === "toggle_maximize") {
          callBackend(cmd, { label: args?.label || currentLabel, ...args }).catch(() => {});
          return null;
        }
        if (sub === "is_focused") {
          try {
            return await callBackend(cmd, { label: args?.label || currentLabel });
          } catch {
            return document.hasFocus();
          }
        }
        if (sub === "is_visible") {
          try {
            return await callBackend(cmd, { label: args?.label || currentLabel });
          } catch {
            return !document.hidden;
          }
        }
        if (sub.startsWith("is_")) return true;
        if (sub === "title") return "Glaido Pro";
        return null;
      }

      if (cmd === "copy_command_text" && args.text) {
        navigator.clipboard?.writeText(args.text).catch(() => {});
      }

      return await callBackend(cmd, args);
    }
  };

  // Invisible top window-drag region for native macOS fullSizeContentView titlebar
  if (currentLabel === "main") {
    window.addEventListener("DOMContentLoaded", () => {
      if (document.getElementById && document.getElementById("glaido-titlebar-drag-region")) {
        return;
      }
      const dragRegion = document.createElement("div");
      dragRegion.id = "glaido-titlebar-drag-region";
      dragRegion.style.cssText = `
        position: fixed; top: 0; left: 78px; right: 220px; height: 36px;
        z-index: 9000; -webkit-app-region: drag; pointer-events: auto;
      `;
      dragRegion.addEventListener("mousedown", e => {
        if (e.target === dragRegion && e.buttons === 1) {
          if (e.detail === 2) {
            callBackend("plugin:window|toggle_maximize", { label: "main" }).catch(() => {});
          } else {
            callBackend("plugin:window|start_dragging", { label: "main" }).catch(() => {});
          }
        }
      });
      document.body.appendChild(dragRegion);
    });
  }
})();
