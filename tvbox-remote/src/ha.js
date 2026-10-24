// Home Assistant's API, for boxes paired in its Android TV Remote integration: keys go out as remote.send_command.
// In the add-on the Supervisor provides the URL and token; outside it, HA_URL and HA_TOKEN (a long-lived token).

const STATE_TTL_MS = 5000; // entity availability is cached briefly; a key press must not wait on it every time

export class HomeAssistant {
  /** @param {{url?: string, token?: string, fetch?: typeof fetch}} options */
  constructor({ url, token, fetch: fetchFn = fetch } = {}) {
    this.url = url?.replace(/\/+$/, '') || null;
    this.token = token || null;
    this.fetch = fetchFn;
    /** @type {Map<string, {state: string, at: number}>} */
    this.states = new Map();
  }

  get enabled() {
    return Boolean(this.url && this.token);
  }

  async request(method, path, body) {
    if (!this.enabled) throw new Error('Home Assistant API not configured');
    const res = await this.fetch(`${this.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Home Assistant: ${res.status} ${res.statusText}`);
    return res.json();
  }

  /** remote.* entities, for linking a box to its Android TV Remote pairing. */
  async remotes() {
    if (!this.enabled) return [];
    const states = await this.request('GET', '/api/states');
    return states
      .filter((s) => s.entity_id.startsWith('remote.'))
      .map((s) => ({ entity: s.entity_id, name: s.attributes?.friendly_name ?? s.entity_id, state: s.state }));
  }

  /** @param {string} entity */
  async available(entity) {
    const cached = this.states.get(entity);
    if (cached && Date.now() - cached.at < STATE_TTL_MS) return cached.state !== 'unavailable';
    const { state } = await this.request('GET', `/api/states/${encodeURIComponent(entity)}`);
    this.states.set(entity, { state, at: Date.now() });
    return state !== 'unavailable';
  }

  /** @param {string} entity @param {string} command Android key name, e.g. DPAD_UP */
  async sendCommand(entity, command) {
    try {
      await this.request('POST', '/api/services/remote/send_command', { entity_id: entity, command });
    } catch (err) {
      this.states.delete(entity); // check availability again next time
      throw err;
    }
  }

  /** Host name of Home Assistant's own address on the home network (internal URL, else external), or null. */
  async internalHost() {
    if (!this.enabled) return null;
    const { internal_url: internal, external_url: external } = await this.request('GET', '/api/config');
    for (const url of [internal, external]) {
      try {
        if (url) return new URL(url).hostname;
      } catch {
        // not a URL: try the next one
      }
    }
    return null;
  }
}

/** HA connection from the environment: the Supervisor inside the add-on, else HA_URL/HA_TOKEN. */
export function homeAssistantFromEnv(env = process.env) {
  if (env.SUPERVISOR_TOKEN) return new HomeAssistant({ url: 'http://supervisor/core', token: env.SUPERVISOR_TOKEN });
  return new HomeAssistant({ url: env.HA_URL, token: env.HA_TOKEN });
}
