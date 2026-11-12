# G4 Candidate Release Manifest

Verification date: 2026-11-12
Original repository baseline: `e0b49c2`
Original repository status: CLEAN

## Verification evidence

- Candidate JavaScript relative imports: 257 resolved (78 files scanned).
- Candidate JavaScript: byte-identical to tested runtime and syntax checked.
- Focused banking regression: 7 suites, 49 tests passed.
- Non-destructive runtime suite: 41 suites, 269 tests passed; 10 suites and 92 tests skipped.
- Real MongoDB concurrency integration: 5 tests passed.
- Real Express/MongoDB HTTP lifecycle: 2 tests passed.
- HTTP test-owned records and sessions cleaned; disposable database dropped.

## Release limitations

- COOP adapter implemented; overall operational readiness remains false.
- COOP sandbox verification and account-validation response semantics remain outstanding.
- AccountTransactions list polling remains disabled.
- Production secrets-key custody and rotation procedures remain to be completed.
- Target deployment migration execution remains unverified.
- This candidate is not production-ready.

## Candidate file SHA-256

| File | SHA-256 |
|---|---|
| `G4_APPLY_AND_TEST.md` | `edcfc3257975ba5d1f1261d3791dd0149730795ad5167a12e140df8d70193370` |
| `G4_FILE_MANIFEST.txt` | `3496f832ae099bfad33b034b9e4063706ea1f0cc6522418dbde5a51826159383` |
| `G4_RELEASE_MANIFEST.md` | `d54ddc63ea795c9d405476d5240fa5d147d929a6ef0ebf27ceeceb85b698c505` |
| `PRD.md` | `88597f37fbe99c140c278b927aab174130d3fb85eb29679225d34ad917d233b7` |
| `SOURCE_CROSSWALK.md` | `51786990181d29872479dcbf8f1032497e39463de24cf5f2f69df0613ac46a5d` |
| `SOURCE_HEAD.txt` | `a27b457874097d93a6490bb1dd837056c9d3ad843535618b1683b22364cba5ac` |
| `architecture-summary.md` | `458d293c5d55b8e8b18c37c5f141cc664f9f2d44e0ba8ce805ddefb8365f377a` |
| `architecture.md` | `582cb9f89f85557b67c8639bafce623fffb2d02116be1174739effcd4472de56` |
| `docs/G4_CORRECTION_AND_VERIFICATION.md` | `7fa7fc8bd39763a2d7d6ad9c9df4c2787500a08ac2e1dc2b4a6ef60ec018f383` |
| `docs/G4_FINAL_IMPLEMENTATION_REVIEW.md` | `52fe3f27e1804841c72ba5f42870c6c293d7b905e3efc8fe00a21b1d9f34edb2` |
| `docs/provider-contracts/CONTRACT_EVIDENCE.md` | `ea2cab61fc8f4afcca26cb270cef62346fc44995125e61a82b7d20d62f0e8b3f` |
| `scripts/migrations/20261111_g4_bank_connection_account_fields.js` | `01e033ee99a7657aaf5c97d7288389b96847a98f69164c32a1d3f72d1972b229` |
| `scripts/migrations/20261111_g4_bank_connection_indexes.js` | `37f57318815be910a210bb7ff094657efadf8c54025412b8110fdf3932f55390` |
| `scripts/migrations/20261111_g4_bank_sync_and_quarantine.js` | `9ecfceb67cdfe94ce49c023352ba74c7f8f236e75746a46a0570933323bec501` |
| `scripts/migrations/20261111_g4_bank_transaction_provenance.js` | `72fc5f812dd95a38fbbb93460328acdd1ddd70b57ca0cd4f58d3df5051178d4f` |
| `scripts/migrations/20261112_g4_legacy_redis_credentials.js` | `b8e5e3fd4353c91eb15a592214353ec7eff30d61940a7bbbd6639162c0b93833` |
| `src/config/environment.js` | `d5c4dd649c71fbae1695a6a39930600e69f68cbb9406cf704a431cf205cbf578` |
| `src/controllers/connection.controller.js` | `a45e7d1f9b6121283b4950d63fb5f3f6523361a2e11ab9cbfaa625bb111c0c22` |
| `src/jobs/bankSync.job.js` | `23855e992030d646eada781bc10f2877c9d1b25bd8b4169773c9fd4c62b5d592` |
| `src/models/BankAccount.js` | `fdba0ace3435640cb11ad56babe07960e27a87798babaaf5f8e7e20a9761a094` |
| `src/models/BankCallbackQuarantine.js` | `6e15052d4d58d44746e7e23c9485fdb260792d69ed50db4829488115fe506487` |
| `src/models/BankConnection.js` | `ffff9467b7aa2c44deae01983543324504bfd7b23251fd3db38e49eadc2a3639` |
| `src/models/BankCredential.js` | `8b43ac754f8850259d11281921e6b8a3f8a364901fd3656102f1e9fdb8f8f25b` |
| `src/models/BankTransaction.js` | `15c3c8be02d434c75d7f3d7a7b137a186c37905baf8b9907a3b0d8e80fab12b1` |
| `src/routes/connection.routes.js` | `43afb8ac03f064d35b53f0855d8b5fe3742bde51b8a8cd369597b7e5b46c5e7f` |
| `src/routes/index.js` | `ae0af85fb1b530df7383d4fba50e1c1be12deced85f1b72d577663260f292e9e` |
| `src/routes/webhook.routes.js` | `b56a512678a40bfaa10c97b9c90ea0afdefbc12cd551e1c7984f10bd6dfe9ebf` |
| `src/server.js` | `b453b82fcd5d30deafba3a5d5d168ce799c07c26913c0a39c3a55090c8e8ba58` |
| `src/services/bank.service.js` | `dcc7d1e0c5f4cc0e2a03c357780a3b3acb992558e542c0396054226e14ad9578` |
| `src/services/banking/bank.factory.js` | `49d7f5c305cf260aeb0f8ead9fcf2ffc80adc672aa932422b538e02f9d0d6b7f` |
| `src/services/banking/bank.interface.js` | `ea1fc04c1b51e6b64f73698b683d70fe62eb6b34cbb31741b82e9c366fb9e0d1` |
| `src/services/banking/bankSync.service.js` | `15a4b21253c219d7d27e2853168ebd54ff656e41e1aac1aba37823f5e7702984` |
| `src/services/banking/callbackQuarantine.service.js` | `7fc1f9175e453537bd9d779fb0a33e8581739d2a42e337b67834eb940864ccfe` |
| `src/services/banking/legacyCredentialMigration.js` | `4bb636bc5d6b04f639f4b4323f287f7504d652ab9896b4ec23ae2359fbdef0d0` |
| `src/services/banking/legacyCredentialMigrationAdapters.js` | `0d59c11d676e283c271f62ea76fedd6f97e8abdace7e6123cb923eda2e113e6b` |
| `src/services/banking/legacyRedisCredentialReader.js` | `1168904d0a423347c04cbd5014a3c3b40c2d60dbfef615860982bd8542bb52e2` |
| `src/services/banking/normalizedTransaction.js` | `d7764ca944c45c11e10fa6047010671a837fa23a38bc241d31d1936aa04dceff` |
| `src/services/banking/processingClaim.js` | `e099a73935fe86ccdd22190caae0eac569284b8d8de8538cbb9f5f8d81e61972` |
| `src/services/banking/providerReadiness.js` | `57117c62fdf4137eb1194a508e8c740497341e59499eb46b66639d9dc00054d3` |
| `src/services/banking/providers/coop/coop.mapper.js` | `7cf99c50834895f8d71b10fd8c20af6795f3045a20d11ca3097230632adc03c7` |
| `src/services/banking/providers/coop/coop.provider.js` | `9a01706fc4b09da46714c7c8472f99caf6edb35ca2d2a87a27660e73b27dfe95` |
| `src/services/banking/providers/coop/coop.readiness.js` | `bfd7878c4b49d2f7ec74b64b3ea328c0472fcbab0c295ec71933f9411891c579` |
| `src/services/banking/providers/coop/coop.syncStrategy.js` | `56a851a32ea57bf6a050e356f02833c583717e1c23e6d4cb921747df8438f3c5` |
| `src/services/banking/providers/disabledProvider.js` | `42f1a9dab0d725f81190ed9c41f47ea3a507714be51b1997215d38c1bbd20ba0` |
| `src/services/banking/providers/equity/equity.provider.js` | `e620edc25a276ba26566ddd3291d378403bdca5301f73b11af04d0ed1558e643` |
| `src/services/banking/providers/kcb/kcb.provider.js` | `2bd88efa5faadf87c2b9482d0d37ea0258d88123bf8a057adae296f646794806` |
| `src/services/banking/providers/ncba/ncba.provider.js` | `4e182598e56d49db911b660ba9844eb948a91e4604603eb726f08f22dec6f2b3` |
| `src/services/banking/secretsManager.js` | `cad9618df1cd72d2c41b5778cab6fa6c3e8dc787971832e349b24ba8487d129d` |
| `src/services/banking/syncCoordination.service.js` | `517c239e8f3ca8e1fda05f55f8a44e09a49df76b880d203674c01bc2c40365b9` |
| `src/services/banking/syncStrategy.js` | `5ed4b489b892c6f768473bc105d2062983a14c0caa3d218ce9727b556bec1940` |
| `src/services/banking/transactionIngestion.service.js` | `73dada80cebc90453ce3e2f49808d3878cb97553ce7fac1761f4856cc4539859` |
| `src/services/connection.service.js` | `1c537386e26aa317687196afa4f727aeb1870a8e75075846c3ac96f67a35570a` |
| `src/services/reconciliation.service.js` | `d8344299b50557351f42793c5fe42dea2bbfc733e813f6cc893992e819abed8a` |
| `src/services/transaction.service.js` | `0c7354500993e94d491cf7d183d60239c7430abbe0e232f0420019fc45d2c741` |
| `src/utils/errors.js` | `ae5682ad64889afaa246a389a7122c89ae2f64fe12d781810da932ddac249542` |
| `src/utils/idempotency.js` | `cd285ce4d5940fbe62c0cc7361cf98b629cbe5095370df5dfc4543c07cc0200b` |
| `src/utils/validators.js` | `7f3600a86adbed18ed80accbe9600fcd21c270160545500e5416b18272ca61b3` |
| `tests/helpers/csrf.js` | `3c975e055b269d5dde50ea5f98d4191944e2d13bb9c2c75e8fda2148da16a657` |
| `tests/helpers/db.js` | `7087df898ec2c56a5d491c13def00b28b1ba0e10224cd92394509faf24f5765e` |
| `tests/helpers/g3Indexes.js` | `faf3a67a264f43fce695f3d8dbf4333ad8807afdea224685d9bbf4f9a2f223cf` |
| `tests/integration/g4.bankConnections.http.test.js` | `562f142d0e39b2c30df9e5b431e64c1eb80a59a41d29bd7d77d4a4c4f4a8a927` |
| `tests/integration/g4.concurrency.test.js` | `9224a1b729a3d68c86359b64b44f975b87f2588071e3d3f378d4faab3c3003eb` |
| `tests/integration/reconciliation.test.js` | `32e31939ad7b7ecfb2febd0809c158732e3511e7c9098a80127e87efd0904a14` |
| `tests/setup.js` | `cdf11134112550464a830152d6de77c6b3e5f9235e176b227a67129e1addbbcc` |
| `tests/unit/bankAccount.connection.test.js` | `ce787c1d9266213a90c594a16122d50cc9a87e4b568840edc9cb5b35ab95e83f` |
| `tests/unit/bankAccount.reconnectLifecycle.test.js` | `e61cc3845f70b98de63048d9c19e308a0d2aecc7d41a56d4957348fe832832fd` |
| `tests/unit/bankConnection.model.test.js` | `d66d72329a1ce4ca4b18ed1c6ab888a19f6e95228eb46e21186ffca8bb952419` |
| `tests/unit/bankCredential.immutableUpdate.test.js` | `0fdbcba5bf58d760a6f5933502f5fae03087adaf5d8854fd602379dc8d0f0bf5` |
| `tests/unit/bankCredential.model.test.js` | `bd584018bc6023b5d8698c3adf1570e659ad8b721635af5757fe9aaa5ac8cc3c` |
| `tests/unit/bankFactory.connection.test.js` | `c3f0a76410990f9a04944d987acb2b1b3c1fabc4cbe7d383f881a07e3bbaf347` |
| `tests/unit/bankSync.checkpointPolicy.test.js` | `fd43612321ed38a99afe10950dba0dbd4779ab96d8fcb4d5019b8c9475d337f4` |
| `tests/unit/bankSync.leaseFencing.test.js` | `9ed7a18dd096c881607c4ad719cc4d2d8e397437cd9c01267caac250ca4f9793` |
| `tests/unit/bankSync.policy.test.js` | `7aebe7ae2608f6425f8a94c1fa80865e47959d16a97b2cb09356614a22485a35` |
| `tests/unit/bankTransaction.schema.test.js` | `a8060a5869a0a3967d0a51770b2cf72ab7bcbc105cf9e053a5a2e6f55d44ea3d` |
| `tests/unit/connectionService.lifecycle.test.js` | `baf5533d7cf38eb135f6c0c5300d96109284f65fe59e3784e94f664231ca26e0` |
| `tests/unit/estateReassignment.test.js` | `b926ed5aaf655f89dbf1395d6292abaf324629ed53d287d1d1949d06a169c550` |
| `tests/unit/legacyCredentialMigration.test.js` | `434960c3f9faab1906ed88d9033b6362e11739555cedd86bd91c81fdccee386b` |
| `tests/unit/legacyCredentialMigrationAdapters.test.js` | `0e042244df5aa2f28180653171182540897607335ac6bfd9c352abde815133e0` |
| `tests/unit/legacyCredentialMigrationCli.test.js` | `ba6fc1d0a68271439841a1ebbf4574b9851f5e7a8ab0635c8f16087d827b0362` |
| `tests/unit/legacyRedisCredentialReader.test.js` | `9d1a2578f8f367dbebfee5ab01dc4a6a6d9c0f28789c00d166b8b939a3a54094` |
| `tests/unit/normalizedTransaction.test.js` | `29b522105f7fb1be1d6cd080c76d77d21f62a34a0cae20b2b47dd02dc3ec5101` |
| `tests/unit/processingClaim.contract.test.js` | `7f630cef67261bb20cdaed77c3c4183d04df3917dd65fdd587fb1870126c3e8c` |
| `tests/unit/providerAdapters.batch05.test.js` | `f5fe5ad7814a91ba2e6a3d8be34bfc6993f95caec2b0e81905d113dcea0b28b8` |
| `tests/unit/secretsManager.test.js` | `d5c2698ac17889db9f9d6c0bd2d37c49b25b4bd56cec280ea066a5aa914ac128` |
| `tests/unit/syncCoordination.leaseFencing.test.js` | `2bc7a0112cfc63b2781341632e08b1394fff5a559423319c45126249f0b4d387` |
| `tests/unit/syncCoordination.test.js` | `480c40ff9c8dc68d945446ed0c07cd8444c7ba68273eff5c4b147a35919df145` |
| `tests/unit/transactionIngestion.authorization.test.js` | `0b380b81a967afffaf53a192ea1f0ada0539d806bca01df5f8c742bd1cf2d91d` |
| `tests/unit/transactionIngestion.claimHandoff.test.js` | `445846e53365dfea79842e5c70a93f45a17abce468254d2cbc77bb88f79f2bb2` |
| `tests/unit/webhookExposure.test.js` | `7ee10d4b5afcd348598f107d125f56dea4b673551bf49b278c489b3d7a86ddec` |
