// Attaches groups of methods, written as object-literal methods in their own
// modules, to a class's prototype. The large server classes (DurableStore,
// PairingService) keep their constructor and core in one file and their
// method groups in a directory beside it. Each method is defined the way a
// class body defines it: writable, configurable and not enumerable.
export function addMethods(Class, ...groups) {
  for (const group of groups) {
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(group))) {
      if (Object.hasOwn(Class.prototype, name)) throw new Error(`${Class.name}.${name} is defined twice.`);
      Object.defineProperty(Class.prototype, name, { ...descriptor, enumerable: false });
    }
  }
}
