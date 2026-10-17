import { hydrateFromApi } from "./lib/hydrate.js";
import { parseMineEvent } from "./lib/mine.js";
import { parseUiEvent } from "./lib/parse.js";
import { parseRetiredEvent } from "./lib/retired.js";
import { type Service, useStore } from "./store.js";

/** Engine WS: /v0/events. Host/port from ?engine=host:port, VITE_ENGINE_HOST/VITE_ENGINE_PORT, else page host. */
function engineUrl(): string {
  const q = new URLSearchParams(location.search).get("engine");
  const env = import.meta.env;
  const host =
    q ?? `${env.VITE_ENGINE_HOST ?? location.hostname}:${env.VITE_ENGINE_PORT ?? "7401"}`;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${host}/v0/events`;
}

/** Connects with automatic reconnect. Returns a disposer. */
export function connectEngine(): () => void {
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const set = (s: Service, st: "connecting" | "connected" | "disconnected") =>
    useStore.getState().setConnection(s, st);
  const open = () => {
    set("engine", "connecting");
    ws = new WebSocket(engineUrl());
    ws.onopen = () => {
      set("engine", "connected");
      void hydrateFromApi();
    };
    ws.onmessage = (m) => {
      const mined = parseMineEvent(m.data);
      if (mined) return useStore.getState().setMine(mined);
      const retired = parseRetiredEvent(m.data);
      if (retired) return useStore.getState().retire(retired);
      const r = parseUiEvent(m.data);
      if (r.ok) useStore.getState().apply(r.event);
      else useStore.getState().reject();
    };
    ws.onclose = () => {
      set("engine", "disconnected");
      if (!stopped) timer = setTimeout(open, 2000);
    };
    ws.onerror = () => ws?.close();
  };
  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    ws?.close();
  };
}
