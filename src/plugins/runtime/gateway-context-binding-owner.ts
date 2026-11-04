import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

// SDK source transforms and native chunks must recognize the same exact-owner brand.
export const { getGatewayContextBindingSlot, prepareGatewayContextBindingOwner } =
  resolveGlobalSingleton(Symbol.for("openclaw.gatewayContextBindingOwner"), () => {
    const gatewayContextBindingOwnerKey = Symbol("gatewayContextBindingOwner");

    class GatewayContextBindingOwner {
      readonly #owner: object;

      constructor(owner: object) {
        this.#owner = owner;
        Object.setPrototypeOf(this, null);
      }

      static read(value: unknown, owner: object): object | undefined {
        return typeof value === "object" &&
          value !== null &&
          #owner in value &&
          value.#owner === owner
          ? value
          : undefined;
      }
    }

    function getGatewayContextBindingSlot(owner: object): object | undefined {
      const slot: unknown = Object.getOwnPropertyDescriptor(
        owner,
        gatewayContextBindingOwnerKey,
      )?.value;
      return GatewayContextBindingOwner.read(slot, owner);
    }

    /** Reserve exact-owner storage before admission freezes the public context. */
    function prepareGatewayContextBindingOwner<T extends object>(owner: T): T {
      if (!getGatewayContextBindingSlot(owner)) {
        Object.defineProperty(owner, gatewayContextBindingOwnerKey, {
          value: new GatewayContextBindingOwner(owner),
        });
      }
      return owner;
    }
    return { getGatewayContextBindingSlot, prepareGatewayContextBindingOwner };
  });
