import React from 'react';
import { StyleSheet, Text } from 'react-native';
import {
  DarkTheme,
  NavigationContainer,
  Theme,
} from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AnimeDetailsScreen } from '../screens/AnimeDetailsScreen';
import { CalendarScreen } from '../screens/CalendarScreen';
import { ExploreScreen } from '../screens/ExploreScreen';
import { HomeScreen } from '../screens/HomeScreen';
import { LibraryScreen } from '../screens/LibraryScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { UniTvDiagnosticScreen } from '../screens/UniTvDiagnosticScreen';
import { VideoPlayerScreen } from '../screens/VideoPlayerScreen';
import {
  isStandaloneUniTvDiagnosticMode,
  isUniTvDiagnosticAvailable,
} from '../diagnostics/unitv-diagnostic';
import { THEME_TOKENS } from '../theme/tokens';

export type MainTabParamList = {
  HomeTab: undefined;
  ExploreTab: undefined;
  CalendarTab: undefined;
  LibraryTab: undefined;
};

export type RootStackParamList = {
  MainTabs: undefined;
  AnimeDetails: { anilistId: number; mediaItemId?: string };
  VideoPlayer: { mediaItemId: string; episodeNumber: number };
  Settings: undefined;
  UniTvDiagnostic: undefined;
};

export interface RootNavigatorScreens {
  HomeTab: React.ComponentType<any>;
  ExploreTab: React.ComponentType<any>;
  CalendarTab: React.ComponentType<any>;
  LibraryTab: React.ComponentType<any>;
  AnimeDetails: React.ComponentType<any>;
  VideoPlayer: React.ComponentType<any>;
  Settings: React.ComponentType<any>;
  UniTvDiagnostic?: React.ComponentType<any>;
}

export interface RootNavigatorProps {
  screens?: Partial<RootNavigatorScreens>;
  withNavigationContainer?: boolean;
}

const APP_NAVIGATION_THEME: Theme = {
  ...DarkTheme,
  dark: true,
  colors: {
    ...DarkTheme.colors,
    primary: THEME_TOKENS.accent.primary,
    background: THEME_TOKENS.bg.canvas,
    card: THEME_TOKENS.bg.surface,
    text: THEME_TOKENS.text.primary,
    border: THEME_TOKENS.border.subtle,
    notification: THEME_TOKENS.accent.secondary,
  },
};

const Tab = createBottomTabNavigator<MainTabParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();

const TAB_GLYPHS: Record<keyof MainTabParamList, string> = {
  HomeTab: '▶',
  ExploreTab: '⌕',
  CalendarTab: '◷',
  LibraryTab: '☰',
};

function TabIcon({
  routeName,
  color,
}: {
  routeName: keyof MainTabParamList;
  color: string;
}): React.JSX.Element {
  return <Text style={[styles.tabIcon, { color }]}>{TAB_GLYPHS[routeName]}</Text>;
}

const DEFAULT_SCREENS: RootNavigatorScreens = {
  HomeTab: HomeScreen,
  ExploreTab: ExploreScreen,
  CalendarTab: CalendarScreen,
  LibraryTab: LibraryScreen,
  AnimeDetails: AnimeDetailsScreen,
  VideoPlayer: VideoPlayerScreen,
  Settings: SettingsScreen,
  UniTvDiagnostic: UniTvDiagnosticScreen,
};

const NavigatorScreensContext = React.createContext<RootNavigatorScreens>(DEFAULT_SCREENS);

function createScreenSlot<K extends keyof RootNavigatorScreens>(screenKey: K) {
  return function ScreenSlot(props: any): React.JSX.Element {
    const resolved = React.useContext(NavigatorScreensContext);
    const Component = resolved[screenKey] ?? DEFAULT_SCREENS[screenKey]!;
    return <Component {...props} />;
  };
}

const HomeTabSlot = createScreenSlot('HomeTab');
const ExploreTabSlot = createScreenSlot('ExploreTab');
const CalendarTabSlot = createScreenSlot('CalendarTab');
const LibraryTabSlot = createScreenSlot('LibraryTab');
const AnimeDetailsSlot = createScreenSlot('AnimeDetails');
const VideoPlayerSlot = createScreenSlot('VideoPlayer');
const SettingsSlot = createScreenSlot('Settings');
const UniTvDiagnosticSlot = createScreenSlot('UniTvDiagnostic');

function MainTabsNavigator(): React.JSX.Element {
  return (
    <Tab.Navigator
      initialRouteName="HomeTab"
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: THEME_TOKENS.accent.primary,
        tabBarInactiveTintColor: THEME_TOKENS.text.secondary,
        tabBarStyle: styles.tabBar,
        tabBarLabelStyle: styles.tabBarLabel,
        tabBarIcon: ({ color }) => <TabIcon routeName={route.name} color={color} />,
      })}
    >
      <Tab.Screen
        name="HomeTab"
        component={HomeTabSlot}
        options={{
          title: 'Início',
          tabBarLabel: 'Início',
          tabBarButtonTestID: 'tab-home',
        }}
      />
      <Tab.Screen
        name="ExploreTab"
        component={ExploreTabSlot}
        options={{
          title: 'Catálogo',
          tabBarLabel: 'Catálogo',
          tabBarButtonTestID: 'tab-explore',
        }}
      />
      <Tab.Screen
        name="CalendarTab"
        component={CalendarTabSlot}
        options={{
          title: 'Calendário',
          tabBarLabel: 'Calendário',
          tabBarButtonTestID: 'tab-calendar',
        }}
      />
      <Tab.Screen
        name="LibraryTab"
        component={LibraryTabSlot}
        options={{
          title: 'Biblioteca',
          tabBarLabel: 'Biblioteca',
          tabBarButtonTestID: 'tab-library',
        }}
      />
    </Tab.Navigator>
  );
}

export function RootNavigator(props: RootNavigatorProps): React.JSX.Element;
export function RootNavigator(): React.JSX.Element;
export function RootNavigator(
  props: RootNavigatorProps = {}
): React.JSX.Element {
  const { screens, withNavigationContainer = true } = props;
  const diagnosticEnabled =
    isUniTvDiagnosticAvailable() || Boolean(screens?.UniTvDiagnostic);
  const initialRouteName: keyof RootStackParamList =
    isStandaloneUniTvDiagnosticMode() ? 'UniTvDiagnostic' : 'MainTabs';

  const resolvedScreens = React.useMemo<RootNavigatorScreens>(
    () => ({
      HomeTab: screens?.HomeTab ?? DEFAULT_SCREENS.HomeTab,
      ExploreTab: screens?.ExploreTab ?? DEFAULT_SCREENS.ExploreTab,
      CalendarTab: screens?.CalendarTab ?? DEFAULT_SCREENS.CalendarTab,
      LibraryTab: screens?.LibraryTab ?? DEFAULT_SCREENS.LibraryTab,
      AnimeDetails: screens?.AnimeDetails ?? DEFAULT_SCREENS.AnimeDetails,
      VideoPlayer: screens?.VideoPlayer ?? DEFAULT_SCREENS.VideoPlayer,
      Settings: screens?.Settings ?? DEFAULT_SCREENS.Settings,
      UniTvDiagnostic:
        screens?.UniTvDiagnostic ?? DEFAULT_SCREENS.UniTvDiagnostic,
    }),
    [
      screens?.HomeTab,
      screens?.ExploreTab,
      screens?.CalendarTab,
      screens?.LibraryTab,
      screens?.AnimeDetails,
      screens?.VideoPlayer,
      screens?.Settings,
      screens?.UniTvDiagnostic,
    ]
  );

  const stackTree = (
    <NavigatorScreensContext.Provider value={resolvedScreens}>
      <Stack.Navigator
        initialRouteName={initialRouteName}
        screenOptions={{
          contentStyle: { backgroundColor: THEME_TOKENS.bg.canvas },
          headerStyle: { backgroundColor: THEME_TOKENS.bg.surface },
          headerTintColor: THEME_TOKENS.text.primary,
          headerShadowVisible: false,
        }}
      >
        <Stack.Screen
          name="MainTabs"
          component={MainTabsNavigator}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="AnimeDetails"
          component={AnimeDetailsSlot}
          options={{ title: 'Detalhes' }}
        />
        <Stack.Screen
          name="VideoPlayer"
          component={VideoPlayerSlot}
          options={{
            presentation: 'fullScreenModal',
            headerShown: false,
            animation: 'fade',
          }}
        />
        <Stack.Screen
          name="Settings"
          component={SettingsSlot}
          options={{
            presentation: 'modal',
            title: 'Configurações',
          }}
        />
        {diagnosticEnabled ? (
          <Stack.Screen
            name="UniTvDiagnostic"
            component={UniTvDiagnosticSlot}
            options={{
              presentation: 'fullScreenModal',
              headerShown: false,
            }}
          />
        ) : null}
      </Stack.Navigator>
    </NavigatorScreensContext.Provider>
  );

  if (!withNavigationContainer) {
    return stackTree;
  }

  return (
    <NavigationContainer theme={APP_NAVIGATION_THEME}>
      {stackTree}
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: THEME_TOKENS.bg.surface,
    borderTopColor: THEME_TOKENS.border.subtle,
    borderTopWidth: 1,
  },
  tabBarLabel: {
    ...THEME_TOKENS.typography.caption,
    fontSize: 11,
  },
  tabIcon: {
    fontSize: 16,
    fontWeight: '700',
  },
});
