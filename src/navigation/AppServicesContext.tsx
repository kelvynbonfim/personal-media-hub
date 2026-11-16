import React from 'react';
import { CatalogService } from '../catalog/catalog-service';
import { BackupService } from '../db/backup-service';
import { LibraryRepository } from '../db/library-repository';
import { DatabaseAdapter } from '../db/schema';
import { CredentialsStore } from '../playback/credentials-store';
import { PlaybackSourceAdapter } from '../playback/types';
import { SupabaseSyncEngine } from '../sync/supabase-sync';

export interface AppServices {
  db: DatabaseAdapter;
  libraryRepository: LibraryRepository;
  backupService: BackupService;
  catalogService: CatalogService;
  credentialsStore: CredentialsStore;
  syncEngine?: SupabaseSyncEngine | null;
  playbackAdapter?: PlaybackSourceAdapter | null;
}

export const AppServicesContext = React.createContext<AppServices | null>(null);

export interface AppServicesProviderProps {
  value: AppServices;
  children: React.ReactNode;
}

export function AppServicesProvider({
  value,
  children,
}: AppServicesProviderProps): React.JSX.Element {
  return (
    <AppServicesContext.Provider value={value}>
      {children}
    </AppServicesContext.Provider>
  );
}

export function useAppServices(): AppServices {
  const context = React.useContext(AppServicesContext);
  if (!context) {
    throw new Error('useAppServices must be used inside an AppServicesProvider.');
  }
  return context;
}

export function useOptionalAppServices(): AppServices | null {
  return React.useContext(AppServicesContext);
}
