// [JS FALLBACK] Fidelity scorer — pure JavaScript implementation.
// The bridge layer (../bridge/) calls this when the C++ native addon is not compiled.
// When native IS available, the C++ version in native/src/fidelity.cpp is used instead.
// Computes semantic fidelity score (0.0–1.0) between original and compressed prompts to ensure meaning preservation.
