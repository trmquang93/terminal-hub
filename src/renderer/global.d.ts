/// <reference types="vite/client" />
import type { HubApi } from '../shared/types';

declare global {
  interface Window {
    hub: HubApi;
  }
}
