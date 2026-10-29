export interface CredentialVault {
  save(target: string, username: string, password: string): Promise<void>;
  read(target: string): Promise<string>;
  exists(target: string): Promise<boolean>;
  delete(target: string): Promise<void>;
}
