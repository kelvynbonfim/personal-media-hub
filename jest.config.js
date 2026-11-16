/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  haste: {
    defaultPlatform: 'android',
    platforms: ['android', 'ios', 'native'],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.[tj]sx?$': [
      'ts-jest',
      {
        tsconfig: {
          allowJs: true,
          jsx: 'react-jsx',
          module: 'commonjs',
          moduleResolution: 'node',
          customConditions: [],
          esModuleInterop: true,
        },
      },
    ],
    '\\.(bmp|gif|jpg|jpeg|mp4|png|psd|svg|webp)$':
      '<rootDir>/node_modules/react-native/jest/assetFileTransformer.js',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@react-navigation|nanoid|standard-navigation)/)',
  ],
  clearMocks: true,
};
