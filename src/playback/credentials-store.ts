import * as SecureStore from 'expo-secure-store';

export interface UniTvCredentials {
  username: string;
  password: string;
}

export interface SecureStoreBackend {
  setItemAsync(key: string, value: string): Promise<void>;
  getItemAsync(key: string): Promise<string | null>;
  deleteItemAsync(key: string): Promise<void>;
}

const UNITV_CREDENTIALS_KEY = 'unitv_credentials_v1';

function validateCredentials(credentials: UniTvCredentials): UniTvCredentials {
  const username =
    typeof credentials?.username === 'string' ? credentials.username.trim() : '';
  const password =
    typeof credentials?.password === 'string' ? credentials.password : '';

  if (!username || password.trim().length === 0) {
    throw new Error('UniTV username and password cannot be empty.');
  }

  return { username, password };
}

/**
 * Persists UniTV credentials exclusively in native secure storage (Android Keystore via expo-secure-store).
 */
export class CredentialsStore {
  constructor(private readonly store?: SecureStoreBackend) {}

  private get backend(): SecureStoreBackend {
    return this.store ?? SecureStore;
  }

  async saveUniTvCredentials(credentials: UniTvCredentials): Promise<void> {
    const validated = validateCredentials(credentials);
    await this.backend.setItemAsync(
      UNITV_CREDENTIALS_KEY,
      JSON.stringify(validated)
    );
  }

  async getUniTvCredentials(): Promise<UniTvCredentials | null> {
    const raw = await this.backend.getItemAsync(UNITV_CREDENTIALS_KEY);
    if (!raw) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    if (
      typeof record.username !== 'string' ||
      typeof record.password !== 'string'
    ) {
      return null;
    }

    const username = record.username.trim();
    if (!username || record.password.trim().length === 0) {
      return null;
    }

    return {
      username,
      password: record.password,
    };
  }

  async clearUniTvCredentials(): Promise<void> {
    await this.backend.deleteItemAsync(UNITV_CREDENTIALS_KEY);
  }
}
