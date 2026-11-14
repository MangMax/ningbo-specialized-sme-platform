Offline stage dependencies

Frozen from `ab503081dae3e24680afc9b07395a7e3ff21fc9f`. These modules retain intermediate schema reads and original-command verification required by the explicit offline upgrade chain. Application code must not import this directory. Pure parsers and unchanged infrastructure remain shared from `lib/platform`; frozen table declarations live in `../legacy-schema.ts` and `../target-schema.ts`.
