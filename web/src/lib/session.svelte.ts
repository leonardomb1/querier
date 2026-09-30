// Who is signed in, for the account menu and what the pages show.

import { api, type Action, type Me, type SysadminPassword } from "./api";

class Session {
  me = $state<Me | null>(null);
  /** what they may do outside any workspace: create one, administer */
  permissions = $state<Action[]>([]);
  /** the sysadmin's: changeable here, and still the generated one (the first sign-in asks for a new one) */
  password = $state<SysadminPassword | null>(null);
  /** the change-password dialog is open */
  changingPassword = $state(false);

  /** May they do `action` outside any workspace? */
  can(action: Action): boolean {
    return this.permissions.includes(action);
  }

  async load(): Promise<boolean> {
    try {
      const r = await api.auth.me();
      this.me = r.me;
      this.permissions = r.permissions;
      this.password = r.password ?? null;
      if (this.password?.mustChange) this.changingPassword = true;
      return true;
    } catch {
      this.me = null;
      this.permissions = [];
      return false;
    }
  }

  async signOut() {
    await api.auth.logout().catch(() => {});
    this.me = null;
    this.permissions = [];
    this.password = null;
    this.changingPassword = false;
    location.hash = "#/login";
  }
}

export const session = new Session();
