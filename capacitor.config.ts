import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.mystorehub.app',
  appName: 'MyStore Hub',
  webDir: 'dist',
  // Loads the live Vercel deploy instead of the bundled dist/ — frontend
  // changes ship via a normal Vercel deploy, no APK rebuild needed. The
  // native bridge (and every registered plugin) works the same either way.
  server: {
    url: 'https://mystorehub.vercel.app',
  },
}

export default config
