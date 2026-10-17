import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import {
  defineDoc,
  type Harness,
  type JsonObject,
} from "@earendil-works/pi-durable";

const Credentials = defineDoc<{ byProvider: Record<string, JsonObject> }>({
  kind: "piton.credentials",
  version: 1,
  scope: "session",
  initial: () => ({ byProvider: {} }),
});

export class PiCredentialStore implements CredentialStore {
  #chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly harness: () => Harness) {}

  async #all() {
    const doc = await this.harness().snapshot(Credentials, context);
    return (doc?.byProvider ?? {}) as unknown as Record<string, Credential>;
  }

  async read(providerId: string) {
    return (await this.#all())[providerId];
  }

  async list() {
    return Object.entries(await this.#all()).map(
      ([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }),
    );
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ) {
    return this.#serialize(async () => {
      const current = await this.read(providerId);
      const next = await fn(current);
      if (next !== undefined) await this.#write(providerId, next);
      return next ?? current;
    });
  }

  delete(providerId: string) {
    return this.#serialize(() => this.#write(providerId, undefined));
  }

  #write(providerId: string, credential: Credential | undefined) {
    return this.harness().commit(async (tx) => {
      const doc = await tx.doc(Credentials);
      if (credential === undefined) delete doc.byProvider[providerId];
      else doc.byProvider[providerId] = credential as unknown as JsonObject;
    }, context);
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(operation, operation);
    this.#chain = result.catch(() => {});
    return result;
  }
}
