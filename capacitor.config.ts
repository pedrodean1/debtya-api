import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.debtya.app',
  appName: 'DebtYa',
  webDir: 'public',
  server: {
    url: 'https://www.debtya.com',
    cleartext: false
  }
};

export default config;
