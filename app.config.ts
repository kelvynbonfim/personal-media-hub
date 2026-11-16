import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Personal Media Hub',
  slug: 'personal-media-hub',
  version: '1.0.0',
  orientation: 'default',
  userInterfaceStyle: 'dark',
  backgroundColor: '#080B0C',
  android: {
    package: 'com.personal.mediahub',
    adaptiveIcon: {
      backgroundColor: '#080B0C',
    },
  },
  ios: {
    bundleIdentifier: 'com.personal.mediahub',
    supportsTablet: true,
  },
  plugins: [
    'expo-sqlite',
    'expo-secure-store',
    'expo-screen-orientation',
    [
      'react-native-video',
      {
        androidExtensions: {
          useExoplayerHls: true,
          useExoplayerDash: true,
          useExoplayerSmoothStreaming: false,
          useExoplayerRtsp: false,
        },
      },
    ],
  ],
});
