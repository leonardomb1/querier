// Who is signed in, for the account menu and what the pages show.

import { api, type Action, type Me } from "./api";

class Session {
  me = $state<Me | null>(null);
  /** what they may do outside any workspace: create one, administer */
  permissions = $state<Action[]>([]);

  /** May they do `action` outside any workspace? */
  can(action: Action): boolean {
    return this.permissions.includes(action);
  }

  async load(): Promise<boolean> {
    try {
      const r = await api.auth.me();
      this.me = r.me;
      this.permissions = r.permissions;
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
    location.hash = "#/login";
  }
}

export const session = new Session();
