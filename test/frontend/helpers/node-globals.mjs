// Node 21+ defines globalThis.navigator as a getter-only accessor; tests install jsdom's in its place.
const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
if (descriptor && !('value' in descriptor) && !descriptor.set) {
  Object.defineProperty(globalThis, 'navigator', { value: globalThis.navigator, writable: true, configurable: true });
}
