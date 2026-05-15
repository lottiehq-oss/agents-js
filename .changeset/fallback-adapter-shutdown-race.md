---
'@livekit/agents': patch
---

fix(agents): suppress phantom fallback warnings and availability flips when FallbackAdapter stream is closed mid-iteration (STT, TTS, LLM). Also propagate parent close → child in the LLM adapter so child streams stop emitting tokens after session shutdown, and ensure STT recovery probes are torn down whenever the stream exits (was a latent leak — probes used to hang until the adapter itself was closed).
