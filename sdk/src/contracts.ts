// Execution bindings for module contracts and pre-V6 registries. Each import carries a 1.5–3 MB contract
// artifact, so they live outside the main entry; load them behind user actions.
export { NameRegistrarContract } from './artifacts/NameRegistrar.js';
export { NameRegistrarLaunchContract } from './artifacts/NameRegistrarLaunch.js';
export { NameRegistrarTieredContract } from './artifacts/NameRegistrarTiered.js';
export { NameResolverContract } from './artifacts/NameResolver.js';
export { NameRegistryContract } from './artifacts/NameRegistry.js';
export { NameRegistryV5Contract } from './artifacts/NameRegistryV5.js';
