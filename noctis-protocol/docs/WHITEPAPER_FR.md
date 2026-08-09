# Le Protocole Noctis — Livre blanc

**Le trading confidentiel sur une blockchain publique, expliqué depuis les fondamentaux.**

Version 1.0 — 2026 · [English version / Version anglaise](./WHITEPAPER.md)

> Ce document est écrit pour être lu à deux vitesses. Chaque chapitre s'ouvre
> sur une **explication en langage simple qu'un débutant peut suivre**, puis
> détaille le **mécanisme technique précis** pour les lecteurs qui veulent
> toute la profondeur. Les encadrés 🔍 sont les plongées techniques ; les
> encadrés 💡 sont les intuitions. Rien d'essentiel ne vit uniquement dans un
> encadré.

---

## Table des matières

1. [Pourquoi la confidentialité compte en trading](#1-pourquoi-la-confidentialité-compte-en-trading)
2. [Contexte : le problème de la blockchain transparente](#2-contexte--le-problème-de-la-blockchain-transparente)
3. [La technologie clé : le chiffrement totalement homomorphe (FHE)](#3-la-technologie-clé--le-chiffrement-totalement-homomorphe-fhe)
4. [Architecture : les composants de Noctis](#4-architecture--les-composants-de-noctis)
5. [La vie d'un trade, étape par étape](#5-la-vie-dun-trade-étape-par-étape)
   - [Étape 1 — Déposer des fonds](#étape-1--déposer-des-fonds)
   - [Étape 2 — Détenir un solde chiffré](#étape-2--détenir-un-solde-chiffré)
   - [Étape 3 — Passer un ordre](#étape-3--passer-un-ordre)
   - [Étape 4 — Le règlement (settlement)](#étape-4--le-règlement-settlement)
   - [Étape 5 — Retirer ses fonds](#étape-5--retirer-ses-fonds)
6. [La boîte à outils de confidentialité, technique par technique](#6-la-boîte-à-outils-de-confidentialité-technique-par-technique)
7. [Ce que Noctis ne cache PAS — le modèle de confiance honnête](#7-ce-que-noctis-ne-cache-pas--le-modèle-de-confiance-honnête)
8. [Ingénierie de sécurité](#8-ingénierie-de-sécurité)
9. [Économie du protocole](#9-économie-du-protocole)
10. [Feuille de route : vers un vrai dark pool (netting V3)](#10-feuille-de-route--vers-un-vrai-dark-pool-netting-v3)
11. [Glossaire](#11-glossaire)

---

## 1. Pourquoi la confidentialité compte en trading

💡 **Imaginez jouer au poker cartes visibles.** C'est exactement ce qu'est le
trading sur une blockchain classique. Tout le monde voit combien d'argent
vous avez, ce que vous achetez, en quelle quantité, et quand. Des observateurs
professionnels exploitent cela en quelques secondes :

- **Le front-running :** un robot voit votre ordre d'achat en attente, achète
  *avant* vous, puis vous revend plus cher. C'est le **MEV** (Maximal
  Extractable Value), qui extrait des centaines de millions de dollars par an
  aux utilisateurs ordinaires.
- **Le copy-trading et le profilage :** n'importe qui peut surveiller un
  portefeuille performant et imiter ou anticiper chacun de ses mouvements.
- **L'exposition commerciale :** un fonds qui accumule une position
  télégraphie sa stratégie au marché entier, qui fait monter le prix contre
  lui.
- **La sécurité personnelle :** un gros solde visible fait de son propriétaire
  une cible.

La finance traditionnelle a résolu une partie du problème avec les **dark
pools** — des lieux d'échange privés où les ordres restent cachés jusqu'à
l'exécution. Mais un dark pool exige de faire confiance à un opérateur, et
les opérateurs ont trahi cette confiance à répétition (plusieurs dark pools
bancaires ont été sanctionnés pour avoir divulgué ou front-run le flux de
leurs clients).

**L'objectif de Noctis :** la confidentialité d'un dark pool, sur une
blockchain publique, **sans faire confiance à aucun opérateur** — parce que
l'opérateur ne *peut* mathématiquement pas lire les données qu'il traite.

---

## 2. Contexte : le problème de la blockchain transparente

💡 **Une blockchain est un tableur public.** La puissance d'Ethereum vient du
fait que des milliers d'ordinateurs vérifient chaque transaction. Mais pour
vérifier, il faut *voir*. Trois catégories de données sont visibles par
absolument tout le monde, pour toujours :

1. **Le calldata** — le contenu de chaque transaction (fonction appelée,
   arguments : montants, adresses…).
2. **L'état (state)** — chaque solde de compte et chaque case de stockage de
   chaque contrat.
3. **Les événements (logs)** — les notifications émises par les contrats,
   utilisées par les applications et les indexeurs.

De plus, deux *canaux auxiliaires* fuient de l'information même quand les
données sont chiffrées :

4. **Les motifs d'accès au stockage** — savoir *quelle* case de stockage a
   changé peut révéler *à qui* appartient la donnée, même si la valeur est
   du chiffré.
5. **Le timing et le graphe de transactions** — qui a envoyé une transaction,
   quand, et quels événements se sont produits dans le même bloc.

Un protocole de confidentialité sérieux doit traiter les cinq. Noctis le fait
— chacun est traité aux §5 et §6.

---

## 3. La technologie clé : le chiffrement totalement homomorphe (FHE)

### 3.1 Pour les débutants

💡 **Une boîte verrouillée à travers laquelle on peut travailler.** Le
chiffrement classique est un coffre-fort : pour faire quoi que ce soit avec le
contenu, il faut l'ouvrir (déchiffrer), et pendant qu'il est ouvert, n'importe
qui à proximité peut regarder. **Le chiffrement totalement homomorphe (FHE)
est une boîte à gants scellée :** on peut manipuler ce qui est à l'intérieur —
additionner des nombres, les comparer — *à travers les gants*, sans jamais
ouvrir la boîte. Le résultat du travail est lui-même enfermé dans une nouvelle
boîte, et seule la personne qui détient la clé peut le regarder.

Concrètement, avec le FHE, un smart contract peut calculer :

- « ajoute ce dépôt chiffré à ce solde chiffré » ✅
- « vérifie que le solde chiffré couvre la taille chiffrée de l'ordre » ✅
- « si oui soustrais le montant, si non soustrais zéro — sans révéler lequel
  des deux s'est produit » ✅

… tandis que personne — ni les validateurs, ni l'équipe du protocole, ni le
contrat lui-même — ne voit jamais un seul nombre en clair.

### 3.2 🔍 Le fhEVM en termes précis

Noctis est construit sur le **fhEVM v0.9 de Zama** (Sepolia aujourd'hui,
Ethereum mainnet via l'architecture coprocesseur) :

- **Types chiffrés.** `euint8 … euint256`, `ebool`, `eaddress`. Noctis
  utilise `euint128` pour les soldes et les montants d'ordres, `euint64` pour
  les transferts de jetons confidentiels (ERC-7984), `ebool` pour les
  conditions, `eaddress` pour les destinataires de paiement cachés.
- **Handles.** Sur la chaîne, un texte chiffré est référencé par un **handle**
  de 32 octets. Le texte chiffré réel vit sur le réseau de coprocesseurs de
  Zama. Le code des contrats manipule des handles ; les coprocesseurs
  exécutent les mathématiques homomorphes.
- **Opérations.** `FHE.add`, `FHE.sub`, `FHE.mul` (arithmétique), `FHE.le`,
  `FHE.ge`, `FHE.eq` (comparaison → `ebool`), et le crucial
  `FHE.select(cond, a, b)` — un **if/else aveugle** : il renvoie `a` ou `b`
  sous forme d'un nouveau texte chiffré sans révéler quelle branche a été
  prise.
- **Chiffrement côté client avec preuves.** Quand un utilisateur chiffre une
  valeur dans son navigateur, il produit `(handle, inputProof)`. La **preuve
  ZK d'entrée** garantit qu'il connaît le texte en clair et lie le chiffré à
  un couple `(contrat, émetteur)` précis — impossible à rejouer ailleurs. Sur
  la chaîne, `FHE.fromExternal(handle, proof)` vérifie cette preuve.
- **Contrôle d'accès (ACL).** Chaque handle a une liste d'accès. Seules les
  adresses explicitement autorisées par le contrat (`FHE.allow`,
  `FHE.allowThis`, `FHE.allowTransient`) peuvent un jour le déchiffrer. Le
  handle du solde d'un utilisateur est lisible par exactement deux parties :
  le vault (pour calculer dessus) et l'utilisateur (pour l'afficher).
- **La déclassification — la seule porte de sortie.** Pour rendre une valeur
  publique, le contrat doit appeler `FHE.makePubliclyDecryptable(handle)`. Un
  **comité à seuil** (le KMS de Zama : *t-parmi-n* nœuds ; aucun nœud seul ne
  peut déchiffrer) produit le texte en clair plus un lot de signatures ; le
  contrat le vérifie avec `FHE.checkSignatures` avant d'agir. **Le
  déchiffrement est une décision du protocole inscrite sur la chaîne, jamais
  une capacité de l'opérateur.**

### 3.3 💡 Ce que cela apporte, en une phrase

> La chaîne peut *faire respecter des règles sur des nombres qu'elle ne peut
> pas lire*, et l'ensemble des nombres qui deviennent un jour publics est une
> liste explicite, auditable et minimale.

---

## 4. Architecture : les composants de Noctis

```text
        Navigateur (Next.js)                   Ethereum (Sepolia)
 ┌─────────────────────────────┐   ┌────────────────────────────────────────┐
 │ Chiffrement FHE (WASM, SDK  │   │  NoctisVaultV2      garde chiffrée     │
 │ relayer ZAMA) — le clair ne │   │   · soldes euint128                    │
 │ quitte jamais la page       │   │   · pseudonymes vaultId                │
 │ Signature d'intents EIP-712 │   │   · retraits furtifs                   │
 └──────────────┬──────────────┘   │   · écritures leurres (chaff)          │
                │ intents          │  NoctisExchangeV2   moteur de trading  │
                ▼ chiffrés         │   · ordres chiffrés relayés            │
 ┌─────────────────────────────┐   │   · adaptateur Uniswap + garde-fous    │
 │ Keeper / Relayer (Node.js)  │──►│  NoctisConfidentialToken (cUSDC)       │
 │ · paie le gas (bouclier     │   │   · jeton ERC-7984 à montants chiffrés │
 │   d'identité)               │   │  GatewayCaller      plomberie décrypt  │
 │ · courrier de preuves       │   └────────────────────────────────────────┘
 │ · exécuteur de retraits     │              │ déchiffrement à seuil
 │ · flush du buffer confid.   │              ▼
 │ · RPC privé (Flashbots)     │   ┌────────────────────────────────────────┐
 └─────────────────────────────┘   │ Coprocesseurs ZAMA + KMS (t-parmi-n)   │
                                   └────────────────────────────────────────┘
 ┌─────────────────────────────┐     Uniswap V2 (liquidité publique)
 │ Subgraph (The Graph)        │     Chainlink (prix de référence)
 │ n'indexe que le public      │
 └─────────────────────────────┘
```

Six composants, un principe : **le texte en clair n'existe que dans le
navigateur de l'utilisateur et — pour l'ensemble minimal déclassifié — dans
la sortie du comité à seuil.**

| Composant | Rôle | Voit des montants en clair ? |
|---|---|---|
| Frontend | chiffre les entrées, signe les intents, déchiffre son propre solde | uniquement ceux de l'utilisateur |
| Vault | garde, soldes chiffrés, retraits | **jamais** |
| Exchange | ordres, règlement, routage Uniswap | seulement les scalaires de règlement déclassifiés |
| Wrapper cUSDC | dépôts confidentiels | jamais (transferts chiffrés) |
| Keeper/relayer | payeur de gas, courrier de déchiffrement, exécuteur | seulement les scalaires déclassifiés |
| Subgraph | statistiques sur événements publics | seulement des agrégats publics |

---

## 5. La vie d'un trade, étape par étape

Ce chapitre déroule tout ce qui se passe entre le financement d'un
portefeuille et le retrait des profits. Pour **chaque étape**, nous précisons :
*ce qui se passe*, *ce qu'un observateur extérieur voit*, *ce qui reste
privé*, et *quelle technologie le garantit*.

---

### Étape 1 — Déposer des fonds

**Ce qui se passe (débutant).** Vous déplacez des jetons de votre portefeuille
vers le coffre (vault) de Noctis. À partir de ce moment, votre argent est
détenu sous forme de *solde chiffré* — imaginez verser vos pièces dans un
coffre opaque où même le gardien ne peut pas les compter.

Noctis offre **deux chemins de dépôt** :

**a) Dépôt standard (ETH ou tout jeton listé).** Vous appelez
`depositETH()`/`depositToken()`. Comme tout transfert blockchain, **le montant
déposé et votre adresse sont publics** pour cette unique transaction — c'est
la physique des chaînes publiques, pas un choix de Noctis. Le montant est
immédiatement converti en solde chiffré (`euint128`), et tout ce qui suit est
privé.

**b) Dépôt confidentiel (USDC, V2.5).** Pour cacher même le montant du dépôt :

1. Vous **enveloppez** (wrap) vos USDC en **cUSDC** — un jeton confidentiel
   conforme au standard **ERC-7984** (implémentation auditée d'OpenZeppelin).
   Le montant du wrap est le dernier nombre public de votre parcours, et il
   est *découplé* de tout ce qui suit.
2. Vous transférez les cUSDC vers le vault via
   `confidentialTransferAndCall(vault, montantChiffré, preuve)`. Le montant
   est **chiffré dans votre navigateur** ; sur la chaîne, c'est un handle
   opaque. Vous pouvez wrapper 10 000 une fois puis déposer 1 234, puis 566,
   puis 4 200 — personne ne peut voir ces nombres, ni même qu'ils diffèrent.
3. Le vault crédite votre solde chiffré de façon homomorphe et applique le
   plafond de dépôt par jeton **sans déchiffrer** : il calcule
   `ok = FHE.le(montant, plafond)` et crédite
   `FHE.select(ok, montant, 0)` ; si `ok` est (chiffré) faux, le jeton
   ERC-7984 rembourse automatiquement le transfert. Même le *rejet* d'un
   dépôt est invisible.
4. Périodiquement, le keeper « flush » le buffer cUSDC agrégé du vault vers de
   l'USDC public afin de payer les règlements. **Seule la somme agrégée** des
   dépôts de la fenêtre est déchiffrée (k-anonymat) — jamais aucun montant
   individuel.

| | Dépôt standard | Dépôt confidentiel |
|---|---|---|
| L'observateur voit | votre adresse, le jeton, le montant exact, l'heure | votre adresse, le jeton, l'heure, un handle opaque |
| Reste privé | tout ce qui suit | **le montant lui-même**, pour toujours |
| Technologie | conversion euint128 au crédit | ERC-7984, chiffrement FHE navigateur, preuve ZK d'entrée, plafond homomorphe + remboursement FHE, flush agrégé k-anonyme |

**Également à cette étape :** votre adresse reçoit silencieusement un
**vaultId** — un pseudonyme pseudo-aléatoire de 256 bits (tiré de
`keccak(user, prevrandao, nonce)`, sans événement émis). Tout le trading
relayé y fera référence, jamais à votre adresse. C'est le masque d'identité
de l'étape 3.

---

### Étape 2 — Détenir un solde chiffré

**Ce qui se passe (débutant).** Votre solde repose dans le vault sous forme
d'un nombre verrouillé. Vous le voyez dans l'application (votre navigateur
détient la clé) ; personne d'autre ne le peut. Quand l'application affiche
« 1 250 USDC », elle a déchiffré ce chiffre *localement, pour vos yeux
uniquement*.

**🔍 Mécanisme.**

- Stockage : `mapping(token => mapping(user => euint128)) balances` — le
  contenu de la case est un handle vers du chiffré, inutile pour un lecteur.
- ACL : après chaque écriture, le vault appelle `FHE.allowThis(nouveauSolde)`
  (pour continuer à calculer) et `FHE.allow(nouveauSolde, user)` (pour que
  *vous* puissiez déchiffrer). Personne d'autre n'est jamais autorisé — il
  n'existe aucune « lecture admin » nulle part dans le protocole.
- Lecture de son propre solde : le navigateur demande un **déchiffrement
  utilisateur** via le SDK relayer de ZAMA — une requête signée EIP-712 que
  le KMS vérifie contre l'ACL on-chain. Votre solde voyage re-chiffré *vers
  votre clé* ; la route API qui assiste ce flux est en `POST` uniquement avec
  `Cache-Control: no-store`, donc aucun couple adresse/handle n'atterrit dans
  des logs de serveur ou de proxy.
- **Écritures leurres (chaff, V2.5).** Chaque fois que le solde de
  *quelqu'un* est modifié par un règlement, le vault réécrit aussi les soldes
  de K autres utilisateurs avec `FHE.add(solde, 0)` — un « +0 » homomorphe
  qui produit un **nouveau texte chiffré indistinguable** sans changer la
  valeur. Un observateur qui compare le stockage voit K+1 soldes changer et
  ne peut pas dire lequel a réellement bougé. C'est la défense contre le
  canal auxiliaire n°4 du §2.

---

### Étape 3 — Passer un ordre

**Ce qui se passe (débutant).** Vous décidez « acheter 0,5 ETH avec des
USDC ». Votre navigateur enferme ce nombre dans une boîte FHE, signe un bon
d'autorisation, et remet la boîte à un coursier (le **relayer**) qui paie le
gas. La chaîne voit que *le coursier* a livré *l'ordre scellé de quelqu'un* —
pas de qui, pas de quelle taille.

**🔍 Mécanisme, fuite par fuite.**

1. **Confidentialité du montant — intents chiffrés de bout en bout.** La
   taille de l'ordre est chiffrée dans le navigateur (`euint128` + preuve ZK
   liée au contrat exchange et au relayer-émetteur). Le texte en clair
   n'atteint jamais les serveurs de Noctis, le relayer, le calldata ou les
   logs. *Personne d'autre que vous ne connaît la taille — pas même le
   protocole.*
2. **Confidentialité de l'identité — relais + pseudonymes.** Vous signez un
   intent EIP-712 `CreateOrder` (typé, protégé contre le rejeu : nonce +
   deadline + chainId). Le relayer soumet
   `createEncryptedOrderViaRelayer(vaultId, …)` : le `tx.from` est le
   relayer, le calldata porte votre *vaultId*, pas votre adresse. Pour un
   observateur de la chaîne, tous les utilisateurs de Noctis se confondent en
   un seul émetteur.
3. **Non-liaison entre ordres — rotation du vaultId.** Quand un ordre relayé
   atteint un état terminal (exécuté/annulé), le vault **fait tourner** le
   vaultId : l'ancien pseudonyme meurt, un nouveau aléatoire est lié (pas
   d'événement, pas de valeur de retour ; vous seul pouvez interroger le
   vôtre via `getMyVaultId()`). Les ordres successifs ne se regroupent pas
   sous un même identifiant — chaque ordre est un *pseudonyme à usage
   unique*.
4. **Hygiène des événements.** `OrderCreated(orderId, baseToken, isBuy,
   timestamp)` — aucune adresse, aucun montant, aucun vaultId dans les logs.
5. **Autorisation sans identité.** Le keeper conserve une table privée et
   persistée `orderId → propriétaire` (issue des intents signés), de sorte
   que seul le vrai propriétaire peut annuler — l'autorité d'annulation sans
   exposition d'identité on-chain.
6. **Économie anti-grief (neutre pour la vie privée).** Les remboursements de
   gas ne sont collectés qu'au règlement, en nature ; la politique off-chain
   du relayer borne les boucles création/annulation sans jamais voir de
   montants.

| Observateur | Voit | Ne voit PAS |
|---|---|---|
| Chaîne | adresse du relayer, paire, sens, horodatage, handle opaque | votre adresse, le montant |
| Relayer | votre IP/signature (existence d'un ordre), paire, sens | **le montant** (handle FHE uniquement) |
| Équipe du protocole | comme la chaîne | montants, identités derrière les vaultIds |

---

### Étape 4 — Le règlement (settlement)

**Ce qui se passe (débutant).** Le protocole vérifie — toujours à travers les
gants FHE — que votre solde verrouillé couvre l'ordre, puis exécute le trade
sur Uniswap et crédite votre solde chiffré du produit. Seul le nombre
strictement nécessaire pour trader sur le marché public est jamais déverrouillé.

**🔍 Mécanisme.**

1. **Solvabilité sans divulgation — le débit gardé.** Le vault calcule
   `suffisant = FHE.le(montantOrdre, solde)` puis
   `debit = FHE.select(suffisant, montantOrdre, 0)`, en appliquant
   `solde := FHE.sub(solde, debit)`. Les ordres insuffisants débitent zéro —
   et *l'écriture de stockage a lieu dans les deux cas*, donc aucun
   observateur n'apprend lequel. Seul le booléen `suffisant` est déclassifié
   (déchiffré à seuil, vérifié on-chain avec `FHE.checkSignatures`) — un
   bit, pas le solde.
2. **Déclassification minimale.** Pour échanger sur Uniswap, le montant
   exécuté doit devenir public — c'est la physique de l'AMM (voir §7 et la
   feuille de route V3 pour la réduction par netting). L'ensemble déclassifié
   par trade est exactement : `{bit de suffisance, montant exécuté}`.
3. **Garde-fous d'oracle.** Le swap est borné par le prix de référence
   Chainlink ± `maxPriceDeviationBPS` et la tolérance de slippage de
   l'utilisateur — endiguement de la manipulation pour la jambe publique.
4. **Chaff sur chaque écriture de solde.** Le crédit de règlement
   (`creditBalanceByVaultId`) et le verrou de débit déclenchent tous deux K
   réécritures leurres (§ étape 2), de sorte que le diff de stockage d'un
   bloc de règlement ne désigne pas le trader.
5. **Hygiène du calldata.** Les appels de règlement référencent le `vaultId`,
   jamais une adresse ; le vault résout le propriétaire en interne.
6. **Frais et remboursements, en transparence.** La commission du protocole
   (5 bps au lancement, plafond dur à 30) va au Safe de trésorerie ; le gas
   du relayer est remboursé en nature depuis le jeton tradé au règlement —
   deux montants publics qui relèvent des *revenus du protocole*, pas des
   données utilisateur.
7. **Bouclier MEV.** Les transactions du keeper peuvent passer par un RPC de
   transactions privées (Flashbots Protect sur mainnet) : les règlements en
   attente ne stationnent jamais dans le mempool public — pas de sandwich,
   pas d'analyse de timing pré-confirmation.

---

### Étape 5 — Retirer ses fonds

**Ce qui se passe (débutant).** Vous demandez votre argent — vers votre
portefeuille, ou vers une **adresse toute neuve sans aucun lien avec vous**.
La demande part dans une boîte (montant *et* destination chiffrés). Quelques
minutes plus tard, c'est le keeper du protocole — pas vous — qui envoie le
paiement. Parce que *quelqu'un d'autre* pousse l'argent vers une *destination
cachée*, un observateur ne peut pas relier « vous avez demandé » à « cette
adresse a été payée ».

**🔍 Mécanisme — « stealth exits v2 », le flux le plus stratifié de Noctis.**

1. **Intent chiffré.** `requestWithdrawalPrivate(token, montantChiffré,
   destinataireChiffré, preuve)` — le montant (`euint128`) *et* le
   destinataire (`eaddress`) sont chiffrés dans votre navigateur. Le
   destinataire est typiquement une adresse fraîche et vide.
2. **Identifiants pseudo-aléatoires.** Les ids sont tirés comme
   `keccak(demandeur, prevrandao, nonce)` — non séquentiels : un observateur
   ne peut pas rejouer l'ordre public des demandes pour reconstruire qui est
   qui.
3. **Événement anonyme.** `WithdrawalRequested(token, timestamp)` — ni
   demandeur, ni id, ni montant dans le log.
4. **Fenêtres de lot (k-anonymat temporel).** Les demandes ne s'exécutent
   qu'aux bornes de fenêtres (300 s sur Sepolia). Toutes les demandes d'une
   fenêtre deviennent temporellement indistinguables.
5. **Paiement exécuté par le keeper — rupture du lien `tx.from`.** À la borne
   de fenêtre, le *keeper* (ou n'importe qui — la fonction est sans
   permission) déclenche l'exécution. Votre portefeuille ne signe rien au
   moment du paiement. Le comité à seuil déchiffre
   `{montant, suffisance, destinataire}` — le troisième et dernier point de
   déclassification du protocole — et le vault paie le destinataire : ERC-20
   par transfert direct, ETH par push-avec-repli (une adresse fraîche n'a pas
   de gas, donc l'ETH est *poussé* ; si un contrat destinataire refuse, le
   paiement devient réclamable — sécurité pull-over-push).
6. **Shredding (V2.5).** L'interface peut découper un retrait logique en
   jusqu'à **8 tranches vers des adresses furtives différentes** réparties
   sur plusieurs fenêtres. Un adversaire qui tente d'apparier « dépôt de X »
   avec « paiements dont la somme vaut X » affronte désormais un problème de
   sous-ensembles (subset-sum) combinatoire, mêlé aux flux des autres
   utilisateurs.
7. **Les limites restent sur le demandeur.** Plafonds journaliers, plafonds
   par demande et nombre de demandes en attente sont tous indexés sur le
   *demandeur* : les fonctions de confidentialité ne permettent pas de
   contourner les contrôles de risque.

| L'observateur voit | Il ne voit PAS |
|---|---|
| un événement anonyme « quelqu'un a demandé un retrait du jeton T » | qui, combien, vers où |
| des transactions de paiement envoyées par le keeper aux bornes de fenêtres | à quelle demande elles correspondent (ids aléatoires, lot) |
| les montants des paiements (physique des transferts) | leur lien avec un dépôt ou un trader — surtout après shredding |

---

## 6. La boîte à outils de confidentialité, technique par technique

Table de référence de chaque technique du protocole, de la fuite qu'elle
ferme, et de la couche où elle agit :

| # | Technique | Ferme | Couche |
|---|---|---|---|
| 1 | Soldes chiffrés `euint128` + ACL stricte | divulgation des soldes | état |
| 2 | Chiffrement FHE navigateur + preuves ZK d'entrée | montant dans calldata/serveurs | intent |
| 3 | Intents relayés EIP-712 (relayer = émetteur) | adresse du trader dans `tx.from` | identité |
| 4 | VaultIds pseudo-aléatoires, assignation silencieuse | reconstruction adresse↔id | identité |
| 5 | Rotation du vaultId à chaque ordre terminal | regroupement des ordres | non-liaison |
| 6 | Débit gardé (`FHE.le` + `FHE.select`) | oracle de solvabilité | état |
| 7 | Déclassification minimale + `FHE.checkSignatures` | sur-divulgation | déchiffrement |
| 8 | Événements anonymes (jeton+horodatage seulement) | analyse des logs | événements |
| 9 | Dépôts confidentiels ERC-7984 (cUSDC) | montant du dépôt | entrée |
| 10 | Flush agrégé du buffer (somme seule déchiffrée) | montants unitaires à l'unwrap | entrée |
| 11 | Plafond homomorphe + remboursement FHE | canal auxiliaire du contrôle de limite | entrée |
| 12 | Écritures leurres chaff (`FHE.add(s,0)`, K leurres) | attribution par diff de stockage | canal auxiliaire |
| 13 | Destinataires chiffrés (`eaddress`) | destination du paiement | sortie |
| 14 | Ids de retrait pseudo-aléatoires + événement anonyme | jointure demande↔paiement | sortie |
| 15 | Fenêtres de lot (300 s) | corrélation temporelle | sortie |
| 16 | Paiements exécutés par le keeper (sans permission) | lien `tx.from` au paiement | sortie |
| 17 | Shredding des retraits (≤ 8 tranches, adresses furtives) | corrélation de montants | sortie |
| 18 | ETH en push-avec-repli | adresses fraîches sans gas | sortie |
| 19 | Routes API en POST + `no-store` ; logs keeper épurés | métadonnées web/ops | off-chain |
| 20 | Option RPC de transactions privées (Flashbots Protect) | exposition mempool/MEV | réseau |

---

## 7. Ce que Noctis ne cache PAS — le modèle de confiance honnête

Un protocole de confidentialité qui exagère ses garanties est un piège. Voici
la liste complète de ce qui reste visible ou requiert de la confiance, et
pourquoi.

**Visible par conception (physique des chaînes publiques) :**

1. **Les montants des dépôts standards** — un transfert public à l'entrée.
   *Atténuation : utiliser le chemin confidentiel cUSDC (montants de dépôt
   chiffrés).*
2. **Le montant public du wrap** en entrant dans cUSDC — découplé de toute
   l'activité ultérieure, mais visible une fois.
3. **Les tailles des swaps de règlement sur Uniswap** — le montant exécuté de
   la jambe publique de chaque trade. *Atténuation aujourd'hui : fenêtres de
   lot + soumission protégée du MEV. Correctif structurel : le netting V3
   (§10) le réduit aux résidus de fenêtres.*
4. **Les montants des transferts de paiement** — les transferts sont publics ;
   le shredding les rend difficiles à corréler mais pas invisibles.
5. **La participation** — le fait qu'*une* adresse ait interagi avec les
   contrats Noctis. Noctis est pseudonyme à l'intérieur de ses flux, pas un
   mixeur d'anonymat.

**Parties de confiance (et pour quoi) :**

| Partie | De confiance pour | INCAPABLE de |
|---|---|---|
| Comité KMS ZAMA (t-parmi-n) | déchiffrer *uniquement* les handles déclassifiés, correctement | lire soldes/ordres à volonté (ACL + seuil) |
| Relayer/keeper (opéré par Noctis) | disponibilité ; ne pas journaliser les métadonnées IP↔ordre | voir les montants (FHE), voler des fonds (pas de garde), forger des paiements (vérifiés par preuve) |
| Fournisseur RPC | ne pas profiler vos motifs d'`eth_call` | lire le contenu chiffré |
| Oracles Chainlink | prix de référence honnêtes (bornés par les garde-fous) | toucher à la garde |
| Code OpenZeppelin/Zama | correction des primitives auditées | — |

**Non-objectifs explicites :** l'anonymat de la couche réseau (utilisez votre
propre RPC/VPN/Tor si votre modèle de menace l'exige) ; cacher *que* vous
utilisez Noctis ; l'anonymat réglementaire (le protocole est pseudonyme, les
entrées/sorties ont des extrémités publiques).

---

## 8. Ingénierie de sécurité

La confidentialité sans sécurité ne vaut rien. Le protocole reprend des
patrons éprouvés, chacun vérifié par sa suite de tests (213 tests au vert en
V2.5) et un audit interne full-stack :

- **Arithmétique gardée partout.** Chaque `FHE.sub` sur un solde est précédé
  de `FHE.le` + `FHE.select` — le débordement négatif chiffré est impossible
  par construction.
- **Aucun transfert avant preuve.** Les fonds physiques ne bougent qu'après
  vérification du déchiffrement à seuil par `FHE.checkSignatures` (patron
  « deduct-auth » en deux phases).
- **Checks-Effects-Interactions + ReentrancyGuard** sur tous les points
  d'entrée modifiant l'état ; SafeERC20 pour les mouvements de jetons ;
  mesure des frais de transfert au dépôt.
- **Pull-over-push** pour les paiements ETH avec repli réclamable.
- **Disjoncteurs.** Plafonds journaliers de retrait par jeton avec
  auto-pause ; surveillance des motifs par utilisateur ; plafonds par demande
  bornant le rayon d'impact d'une compromission du KMS.
- **Timelock de gouvernance** sur les changements de paramètres ; rôle
  gardien limité à la pause ; destinataire des frais = Safe ; plafond dur
  `MAX_FEE_BPS` dans le code.
- **Discipline EIP-170.** Vault et exchange frôlent la limite de
  24 576 octets ; la composition du compilateur est épinglée et la taille
  vérifiée par les tests.
- **Coûts de confidentialité bornés.** Le K du chaff est réglable par le
  propriétaire (défaut 2, max 8) : le surcoût en gas des leurres est
  explicite et plafonné.

---

## 9. Économie du protocole

- **Commission du protocole :** 5 bps (0,05 %) par trade exécuté au
  lancement, prélevée sur le produit du règlement vers le Safe de trésorerie.
  Plafond dur `MAX_FEE_BPS = 30`.
- **Remboursements de gas :** le relayer avance le gas au nom de la
  confidentialité ; il est remboursé en nature depuis le jeton tradé au
  règlement (`gasRecipient` = portefeuille flottant du relayer, distinct de la
  trésorerie — pas d'aller-retour par le Safe). Les ordres annulés coûtent au
  relayer ; une politique off-chain borne ce grief sans toucher à la vie
  privée.
- **Pas de token, pas de ponzinomique.** Revenus = commissions. Les fonctions
  de confidentialité (chaff, lots) ont des coûts en gas transparents et
  bornés, portés par les flux qui les utilisent.

---

## 10. Feuille de route : vers un vrai dark pool (netting V3)

Aujourd'hui, la jambe publique Uniswap de chaque trade révèle sa taille
exécutée (§7.3). Le jalon V3 — le **netting homomorphe par lots** — supprime
cette dernière divulgation unitaire :

> Les ordres s'accumulent *chiffrés* dans des fenêtres fixes. Les achats et
> les ventes sur une même paire s'annulent *à l'intérieur du domaine FHE*.
> Seul le **résidu net** de la fenêtre est déchiffré et échangé sur Uniswap.
> Le volume croisé se règle en interne au prix médian d'oracle — zéro
> slippage, zéro frais LP, zéro empreinte publique. Avec un flux équilibré,
> le résidu tend vers zéro et Noctis devient un véritable dark pool dont
> l'opérateur ne peut pas lire le carnet.

La conception complète est spécifiée dans
[`ROADMAP_V3_NETTING.md`](./ROADMAP_V3_NETTING.md) et formalisée dans le
papier de recherche
[`research/FHE_BATCH_NETTING.md`](./research/FHE_BATCH_NETTING.md), qui
démontre aussi que la divulgation du résidu est le minimum
informationnel pour tout lieu d'échange connecté à un AMM.

---

## 11. Glossaire

| Terme | Signification |
|---|---|
| **FHE** | Chiffrement totalement homomorphe — calculer sur des données chiffrées sans les déchiffrer |
| **fhEVM** | L'extension de l'EVM par Zama avec types et opérations FHE |
| **Handle** | Référence on-chain de 32 octets vers un texte chiffré stocké sur le réseau de coprocesseurs |
| **ACL** | Liste de contrôle d'accès décidant qui peut déchiffrer un handle donné |
| **Preuve d'entrée** | Preuve ZK qu'une valeur chiffrée côté client est bien formée et liée à un contrat+émetteur |
| **Déclassification** | L'acte explicite, vérifié on-chain, de rendre publique une valeur chiffrée |
| **KMS / comité à seuil** | t-parmi-n nœuds qui déchiffrent conjointement les valeurs déclassifiées ; aucun ne le peut seul |
| **euint128 / ebool / eaddress** | Types chiffrés : entier / booléen / adresse |
| **`FHE.select`** | If/else chiffré — choisit entre deux chiffrés sans révéler lequel |
| **Débit gardé** | Soustraire `select(suffisant, montant, 0)` pour rendre les échecs invisibles |
| **VaultId** | Pseudonyme pseudo-aléatoire remplaçant l'adresse de l'utilisateur dans les flux relayés |
| **Relayer** | Service qui soumet les transactions des utilisateurs pour que `tx.from` ne les expose jamais |
| **Keeper** | Service qui déclenche les étapes temporelles du protocole (règlement, paiements, flushes) |
| **ERC-7984** | Standard de jeton fongible confidentiel (montants chiffrés) |
| **cUSDC** | Le wrapper ERC-7984 de Noctis autour de l'USDC |
| **Chaff / écritures leurres** | Réécritures « +0 » factices masquant quel solde a réellement changé |
| **Sortie furtive (stealth exit)** | Retrait vers un destinataire chiffré, sans lien préalable |
| **Shredding** | Découpage d'un retrait en plusieurs tranches vers des adresses furtives distinctes |
| **Fenêtre de lot** | Période fixe regroupant les demandes pour une exécution indistinguable |
| **k-anonymat** | Être indistinguable au sein d'un ensemble de k participants |
| **MEV** | Maximal Extractable Value — profits extraits en réordonnant/front-runnant les transactions |
| **Dark pool** | Lieu d'échange dont le carnet d'ordres est caché jusqu'à l'exécution |
| **Netting** | Annulation interne des flux opposés pour ne trader publiquement que la différence nette |
| **Problème de sous-ensembles (subset-sum)** | Le casse-tête (difficile) d'un observateur qui apparie des paiements shreddés à un retrait |

---

*Protocole Noctis — 2026. Ce livre blanc décrit la version V2.5 du protocole
(Sepolia). Les contrats, les tests et la documentation opérationnelle vivent
dans le dépôt du protocole. L'édition anglaise de ce document est
[WHITEPAPER.md](./WHITEPAPER.md).*
