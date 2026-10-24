import type { ApplicationInfo } from '@opencut/core';

export const APP_INFO_CHANNEL = 'app:get-info';

export interface DesktopAPI {
  getApplicationInfo(): Promise<ApplicationInfo>;
}
