import React from 'react';

if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number =>
    setTimeout(() => cb(Date.now()), 0) as unknown as number;
}

if (typeof globalThis.cancelAnimationFrame !== 'function') {
  globalThis.cancelAnimationFrame = (id: number): void => {
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  };
}

type AnyProps = Record<string, any>;

function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style) {
    return {};
  }
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (acc, item) => Object.assign(acc, flattenStyle(item)),
      {}
    );
  }
  if (typeof style === 'object') {
    return { ...(style as Record<string, unknown>) };
  }
  return {};
}

function renderOptionalComponent(comp: unknown): React.ReactNode {
  if (!comp) {
    return null;
  }
  if (typeof comp === 'function') {
    const Component = comp as React.ComponentType;
    return React.createElement(Component);
  }
  return comp as React.ReactNode;
}

function createHostComponent(name: string) {
  const Component = React.forwardRef<unknown, AnyProps>((props, ref) =>
    React.createElement(name, { ...props, ref }, props.children)
  );
  Component.displayName = name;
  return Component;
}

jest.mock('react-native', () => {
  const View = createHostComponent('View');
  const Text = createHostComponent('Text');
  const TextInput = createHostComponent('TextInput');
  const Image = createHostComponent('Image');
  const ScrollView = createHostComponent('RCTScrollView');
  const Switch = createHostComponent('RCTSwitch');
  const ActivityIndicator = createHostComponent('ActivityIndicator');
  const RefreshControl = createHostComponent('RefreshControl');
  const StatusBar = createHostComponent('StatusBar');

  const ImageBackground = React.forwardRef<unknown, AnyProps>(
    ({ children, ...props }, ref) => React.createElement('View', { ...props, ref }, children)
  );

  const SafeAreaView = React.forwardRef<unknown, AnyProps>(
    ({ children, ...props }, ref) => React.createElement('View', { ...props, ref }, children)
  );

  const KeyboardAvoidingView = React.forwardRef<unknown, AnyProps>(
    ({ children, ...props }, ref) => React.createElement('View', { ...props, ref }, children)
  );

  const Modal = React.forwardRef<unknown, AnyProps>(
    ({ visible = true, children, ...props }, ref) =>
      visible ? React.createElement('Modal', { ...props, ref, visible }, children) : null
  );

  const TouchableOpacity = React.forwardRef<unknown, AnyProps>(
    ({ children, ...props }, ref) => React.createElement('View', { ...props, ref }, children)
  );

  const TouchableHighlight = React.forwardRef<unknown, AnyProps>(
    ({ children, ...props }, ref) => React.createElement('View', { ...props, ref }, children)
  );

  const TouchableWithoutFeedback = React.forwardRef<unknown, AnyProps>(
    ({ children, ...props }, ref) => React.createElement('View', { ...props, ref }, children)
  );

  const Pressable = React.forwardRef<unknown, AnyProps>(
    ({ children, style, ...props }, ref) => {
      const resolvedStyle = typeof style === 'function' ? style({ pressed: false }) : style;
      const resolvedChildren =
        typeof children === 'function' ? children({ pressed: false }) : children;
      return React.createElement('View', { ...props, ref, style: resolvedStyle }, resolvedChildren);
    }
  );

  const FlatList = ({
    data = [],
    renderItem,
    keyExtractor,
    ListHeaderComponent,
    ListFooterComponent,
    ListEmptyComponent,
    ...props
  }: AnyProps) => {
    const items = Array.isArray(data) ? data : [];
    const separators = {
      highlight: jest.fn(),
      unhighlight: jest.fn(),
      updateProps: jest.fn(),
    };

    const renderedItems =
      items.length > 0 && typeof renderItem === 'function'
        ? items.map((item, index) => {
            const key =
              typeof keyExtractor === 'function' ? String(keyExtractor(item, index)) : String(index);
            return React.createElement(
              React.Fragment,
              { key },
              renderItem({ item, index, separators })
            );
          })
        : renderOptionalComponent(ListEmptyComponent);

    return React.createElement(
      'RCTScrollView',
      props,
      renderOptionalComponent(ListHeaderComponent),
      renderedItems,
      renderOptionalComponent(ListFooterComponent)
    );
  };

  const SectionList = ({ sections = [], renderItem, renderSectionHeader, ...props }: AnyProps) => {
    const sectionNodes = Array.isArray(sections)
      ? sections.map((section: AnyProps, sectionIndex: number) =>
          React.createElement(
            React.Fragment,
            { key: String(sectionIndex) },
            typeof renderSectionHeader === 'function'
              ? renderSectionHeader({ section })
              : null,
            Array.isArray(section.data) && typeof renderItem === 'function'
              ? section.data.map((item: unknown, index: number) =>
                  React.createElement(
                    React.Fragment,
                    { key: `${sectionIndex}-${index}` },
                    renderItem({ item, index, section })
                  )
                )
              : null
          )
        )
      : null;
    return React.createElement('RCTScrollView', props, sectionNodes);
  };

  class AnimatedValue {
    private value: number;
    constructor(initial: number) {
      this.value = initial;
    }
    setValue(next: number) {
      this.value = next;
    }
    interpolate() {
      return this.value;
    }
    addListener() {
      return '1';
    }
    removeListener() {}
    removeAllListeners() {}
    stopAnimation(cb?: (value: number) => void) {
      cb?.(this.value);
    }
  }

  const createAnimation = () => ({
    start: (cb?: (result: { finished: boolean }) => void) => {
      cb?.({ finished: true });
    },
    stop: jest.fn(),
    reset: jest.fn(),
  });

  const Animated = {
    Value: AnimatedValue,
    timing: jest.fn(() => createAnimation()),
    spring: jest.fn(() => createAnimation()),
    parallel: jest.fn(() => createAnimation()),
    sequence: jest.fn(() => createAnimation()),
    loop: jest.fn(() => createAnimation()),
    event: jest.fn(() => jest.fn()),
    divide: jest.fn((a: unknown) => a),
    multiply: jest.fn((a: unknown) => a),
    add: jest.fn((a: unknown) => a),
    subtract: jest.fn((a: unknown) => a),
    createAnimatedComponent: <T extends React.ComponentType<any>>(comp: T): T => comp,
    View,
    Text,
    Image,
  };

  const Easing = {
    linear: (t: number) => t,
    ease: (t: number) => t,
    quad: (t: number) => t * t,
    cubic: (t: number) => t * t * t,
    poly: () => (t: number) => t,
    bezier: () => (t: number) => t,
    in: (fn: (t: number) => number) => fn,
    out: (fn: (t: number) => number) => fn,
    inOut: (fn: (t: number) => number) => fn,
  };

  const StyleSheet = {
    create: <T extends Record<string, unknown>>(styles: T): T => styles,
    flatten: flattenStyle,
    hairlineWidth: 1,
    absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
    absoluteFillObject: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  };

  const Platform = {
    OS: 'android' as const,
    Version: 35,
    select: <T>(specifics: { android?: T; ios?: T; default?: T }): T | undefined =>
      specifics.android ?? specifics.default,
  };

  const defaultDimensions = { width: 390, height: 844, scale: 2, fontScale: 1 };

  return {
    View,
    Text,
    TextInput,
    Image,
    ImageBackground,
    ScrollView,
    FlatList,
    SectionList,
    TouchableOpacity,
    TouchableHighlight,
    TouchableWithoutFeedback,
    Pressable,
    Switch,
    Modal,
    ActivityIndicator,
    SafeAreaView,
    KeyboardAvoidingView,
    RefreshControl,
    StatusBar,
    Animated,
    Easing,
    StyleSheet,
    Platform,
    PlatformColor: (name: string) => name,
    I18nManager: {
      isRTL: false,
      getConstants: () => ({ isRTL: false, doLeftAndRightSwapInRTL: false }),
      allowRTL: jest.fn(),
      forceRTL: jest.fn(),
    },
    Keyboard: {
      dismiss: jest.fn(),
      addListener: jest.fn(() => ({ remove: jest.fn() })),
    },
    UIManager: {
      getViewManagerConfig: jest.fn(() => null),
    },
    useAnimatedValue: (initial: number) => new AnimatedValue(initial),
    Dimensions: {
      get: () => defaultDimensions,
      addEventListener: () => ({ remove: jest.fn() }),
    },
    useWindowDimensions: () => defaultDimensions,
    PixelRatio: {
      get: () => 2,
      roundToNearestPixel: (n: number) => Math.round(n),
    },
    Alert: {
      alert: jest.fn(),
    },
    Share: {
      share: jest.fn(async () => ({ action: 'sharedAction' })),
    },
    Linking: {
      openURL: jest.fn(async () => true),
      canOpenURL: jest.fn(async () => true),
      getInitialURL: jest.fn(async () => null),
      addEventListener: jest.fn(() => ({ remove: jest.fn() })),
    },
    BackHandler: {
      addEventListener: jest.fn(() => ({ remove: jest.fn() })),
      removeEventListener: jest.fn(),
    },
    AppState: {
      currentState: 'active',
      addEventListener: jest.fn(() => ({ remove: jest.fn() })),
    },
    NativeModules: {},
  };
});

jest.mock('expo-sqlite', () => {
  const createAsyncDb = () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async () => ({ lastInsertRowId: 1, changes: 1 })),
    getAllAsync: jest.fn(async () => []),
    getFirstAsync: jest.fn(async () => null),
    withTransactionAsync: jest.fn(async (task: () => Promise<void>) => {
      await task();
    }),
    closeAsync: jest.fn(async () => undefined),
  });

  const createSyncDb = () => ({
    execSync: jest.fn(() => undefined),
    runSync: jest.fn(() => ({ lastInsertRowId: 1, changes: 1 })),
    getAllSync: jest.fn(() => []),
    getFirstSync: jest.fn(() => null),
    closeSync: jest.fn(() => undefined),
  });

  const sharedAsyncDb = createAsyncDb();

  return {
    openDatabaseAsync: jest.fn(async () => createAsyncDb()),
    openDatabaseSync: jest.fn(() => createSyncDb()),
    SQLiteProvider: ({ children }: AnyProps) =>
      React.createElement(React.Fragment, null, children),
    useSQLiteContext: jest.fn(() => sharedAsyncDb),
  };
});

const secureStoreMemory = new Map<string, string>();
delete process.env.EXPO_PUBLIC_UNITV_DIAGNOSTIC;

beforeEach(() => {
  secureStoreMemory.clear();
  delete process.env.EXPO_PUBLIC_UNITV_DIAGNOSTIC;
});

jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(async (key: string, value: string) => {
    secureStoreMemory.set(key, value);
  }),
  getItemAsync: jest.fn(async (key: string) => secureStoreMemory.get(key) ?? null),
  deleteItemAsync: jest.fn(async (key: string) => {
    secureStoreMemory.delete(key);
  }),
  setItem: jest.fn((key: string, value: string) => {
    secureStoreMemory.set(key, value);
  }),
  getItem: jest.fn((key: string) => secureStoreMemory.get(key) ?? null),
  deleteItem: jest.fn((key: string) => {
    secureStoreMemory.delete(key);
  }),
  isAvailableAsync: jest.fn(async () => true),
}));

jest.mock('react-native-video', () => {
  const Video = React.forwardRef<unknown, AnyProps>((props, ref) => {
    React.useImperativeHandle(ref, () => ({
      seek: jest.fn(),
      pause: jest.fn(),
      resume: jest.fn(),
      setSource: jest.fn(),
    }));
    return React.createElement('Video', props, props.children);
  });
  Video.displayName = 'Video';

  return {
    __esModule: true,
    default: Video,
    Video,
    SelectedTrackType: {
      SYSTEM: 'system',
      DISABLED: 'disabled',
      TITLE: 'title',
      LANGUAGE: 'language',
      INDEX: 'index',
    },
    SelectedVideoTrackType: {
      AUTO: 'auto',
      DISABLED: 'disabled',
      RESOLUTION: 'resolution',
      INDEX: 'index',
    },
    ResizeMode: {
      CONTAIN: 'contain',
      COVER: 'cover',
      STRETCH: 'stretch',
      NONE: 'none',
    },
  };
});

jest.mock('react-native-webview', () => {
  const WebView = React.forwardRef<unknown, AnyProps>((props, ref) => {
    React.useImperativeHandle(
      ref,
      () => ({
        injectJavaScript: jest.fn(),
        reload: jest.fn(),
        goBack: jest.fn(),
        goForward: jest.fn(),
        stopLoading: jest.fn(),
      }),
      []
    );
    return React.createElement('WebView', props, props.children);
  });
  WebView.displayName = 'WebView';

  return {
    __esModule: true,
    default: WebView,
    WebView,
  };
});

jest.mock('react-native-safe-area-context', () => {
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  const SafeAreaInsetsContext = React.createContext(insets);
  const SafeAreaFrameContext = React.createContext(frame);
  return {
    SafeAreaInsetsContext,
    SafeAreaFrameContext,
    SafeAreaContext: SafeAreaInsetsContext,
    SafeAreaProvider: ({ children, ...props }: AnyProps) =>
      React.createElement('View', props, children),
    SafeAreaView: ({ children, ...props }: AnyProps) =>
      React.createElement('View', props, children),
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
    useSafeArea: () => insets,
    initialWindowMetrics: { insets, frame },
  };
});

jest.mock('react-native-screens', () => {
  const PassThrough = ({ children, ...props }: AnyProps) =>
    React.createElement('View', props, children);

  return {
    enableScreens: jest.fn(),
    screensEnabled: jest.fn(() => true),
    isSearchBarAvailableForCurrentPlatform: false,
    compatibilityFlags: { usesNewArch: false },
    Screen: PassThrough,
    ScreenContainer: PassThrough,
    ScreenStack: PassThrough,
    ScreenStackItem: PassThrough,
    ScreenFooter: PassThrough,
    ScreenStackHeaderBackButtonImage: PassThrough,
    ScreenStackHeaderCenterView: PassThrough,
    ScreenStackHeaderLeftView: PassThrough,
    ScreenStackHeaderRightView: PassThrough,
    ScreenStackHeaderSearchBarView: PassThrough,
    SearchBar: PassThrough,
    Tabs: PassThrough,
  };
});

jest.mock('expo-screen-orientation', () => ({
  OrientationLock: {
    DEFAULT: 0,
    ALL: 1,
    PORTRAIT: 2,
    PORTRAIT_UP: 3,
    PORTRAIT_DOWN: 4,
    LANDSCAPE: 5,
    LANDSCAPE_LEFT: 6,
    LANDSCAPE_RIGHT: 7,
  },
  lockAsync: jest.fn(async () => undefined),
  unlockAsync: jest.fn(async () => undefined),
}));
