import type { KootaniApi } from "../shared/ipc";

declare global {
  interface Window {
    kootani: KootaniApi;
  }
}

export {};
