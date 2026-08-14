# XPA-8 B-2.1 — Proposed Lesson Specifications

**Status:** ✅ **Specification APPROVED** · 🔴 **implementation halted at STOP GATE #1**
**Scope:** the two retained placeholder lessons. **No media generated, no uploads, no DB writes.**

> **STOP GATE #1 fired.** Producing these assets requires a video-production step
> this environment cannot perform: no `ffmpeg`/`ffprobe`, and **no French
> text-to-speech voice** (only `en-US` SAPI voices are installed). The house
> format carries a narration audio track — measured, see §4.1 — so every asset
> this environment could emit would be silent, synthetic, or a reused sibling,
> all of which the implementation brief forbids. §4 records the complete
> production package so a producer can execute without re-deriving anything.

---

## 0. Context established from the existing courses

Everything below is grounded in material that already exists on the platform, not
invented. What was read:

| Source | What it established |
|---|---|
| C1-F3 full structure (4 modules, 17 lessons) | progression, tone, 2-minute lesson rhythm |
| C2-F4 full structure (4 modules, 13 lessons) | progression, capstone position |
| C1-F2 (prerequisite course) | the **base method** this platform teaches |
| PDF *"Traitement d'une réclamation client"* (F2·M4·L2) | **les 5 étapes d'un traitement réussi**, the apaisement vocabulary, "le piège le plus fréquent" |
| PDF *"Gérer un client difficile"* (F2·M3) | **les 4 étapes pour désamorcer**, 4 client profiles, "dire non sans braquer", escalation triggers |
| 5 voice scenarios (Awa, Ibrahima, Amara, Fatou, Kader) | domain (telecom / Mobile Money), register, named-persona convention |

**House conventions observed and followed:** named Senegalese personas
(Awa, Ibrahima, Amara, Fatou, Kader, Daba, Moussa); telecom and Mobile Money as
the working domain; *teranga* as the cultural anchor; the tagline « La teranga au
cœur de l'expérience client. »; document types **CHECKLIST** and **FICHE
RÉFLEXE**; headers in the form `F3 · M3 · L4 — …`.

**The taught method must not be contradicted.** Both scripts below deliberately
reuse the existing five steps rather than proposing a competing framework.

---

## 1. ⚠️ A constraint that shapes the modality choice

The completion mechanism is video playback, and the manual *"Marquer comme
complétée"* button is `if (pilotMode) return null` — production runs in pilot
(B-2.6). **A written or interactive-only lesson cannot be completed today**, so
it would not clear the completeness invariant, and B-2.1 would not close.

**Therefore video is recommended for both lessons** — not because it is
pedagogically superior in every case, but because it is the only modality that
currently registers completion. A companion PDF is proposed as *enrichment*, in
the existing CHECKLIST / FICHE RÉFLEXE house style.

If B-2.6 is fixed first, C2-F4's capstone would be a strong candidate for an
interactive case instead. That sequencing is a product decision.

---

# LESSON 1 — C1-F3 · M3 · L4

**"Prioriser et organiser ses réponses"** · `d59a1304-7d81-4bc3-aa97-ed0e2deffc22`
Target 2 minutes · beginner · free course

### Position in the progression

Module 3 is *"Organiser son travail sur les canaux digitaux"*:

| | | Already teaches |
|---|---|---|
| L1 | Accuser réception et tenir le client informé | the holding reply and the promised delay |
| L2 | Gérer plusieurs conversations sans les mélanger | thread hygiene, context switching |
| L3 | Suivre, relancer et clôturer une conversation | follow-through and closure |
| **L4** | **Prioriser et organiser ses réponses** | **← the missing decision layer** |

L1–L3 teach how to *handle* a conversation well. None answers **which one you
touch first when thirty arrive at once.** That is this lesson, and it is the last
lesson of the module because the method only makes sense once the mechanics are
known.

**Must not duplicate:** the holding reply itself (L1), thread separation (L2),
follow-up mechanics (L3), tone and writing (M2), channel panorama (M1L3).
**Must not become:** generic productivity advice. No inbox-zero, no time-boxing
theory — the criteria must come from customer impact, not from personal
efficiency.

### A. Learning objective

Décider, face à un afflux de messages sur plusieurs canaux, dans quel ordre
répondre — et organiser son temps de travail pour que la priorisation ne se
paie pas en qualité de réponse.

### B. Learning outcomes

1. Expliquer pourquoi répondre dans l'ordre d'arrivée est un mauvais réflexe en service client digital.
2. Classer des demandes entrantes selon trois critères : visibilité publique, degré de blocage, engagement déjà pris.
3. Organiser sa journée par passages réguliers plutôt qu'en réaction continue.
4. Utiliser l'accusé de réception comme outil de priorisation, pas seulement de politesse.

### C. Structure (2 min)

| Temps | Bloc |
|---|---|
| 0:00–0:20 | La situation réelle : le matin, tous canaux ouverts |
| 0:20–0:35 | Le mauvais réflexe : l'ordre d'arrivée, ou le plus facile |
| 0:35–1:20 | Les trois critères |
| 1:20–1:40 | S'organiser par vagues |
| 1:40–1:55 | Protéger la qualité : l'accusé de réception |
| 1:55–2:10 | À retenir |

### D / J. Narration script + scene outline

> **Scène 1 — Écran partagé : WhatsApp, Facebook, e-mail qui se remplissent**
>
> Il est neuf heures. Vous ouvrez vos canaux : douze messages WhatsApp, six
> commentaires Facebook, une dizaine d'e-mails. Vous ne pouvez pas tout traiter
> en même temps. La vraie question n'est donc pas « comment aller plus vite ? »,
> mais « par quoi commencer ? »
>
> **Scène 2 — Une file d'attente qui défile dans l'ordre d'arrivée**
>
> Le réflexe naturel, c'est de répondre dans l'ordre d'arrivée. Ou de commencer
> par le plus facile, pour faire baisser le compteur. Les deux vous desservent :
> le plus urgent attend pendant que vous traitez le plus simple.
>
> Trois critères, dans cet ordre.
>
> **Scène 3 — Critère 1 : icônes public / privé**
>
> Premier critère : **le public avant le privé**. Un message privé attend dans
> une boîte. Un commentaire public attend sous les yeux de tous vos clients.
> Vous avez vu ce que change l'écrit public : ici, il change aussi l'ordre de
> vos priorités.
>
> **Scène 4 — Critère 2 : deux cartes, « bloqué » et « gêné »**
>
> Deuxième critère : **le bloquant avant le gênant**. Demandez-vous ce que le
> client ne peut plus faire. Une cliente dont le compte est bloqué, qui ne peut
> ni payer ni retirer, passe avant une demande d'information — même si
> l'information est arrivée en premier.
>
> **Scène 5 — Critère 3 : un sablier sur un message déjà répondu**
>
> Troisième critère : **la promesse échue avant la nouvelle demande**. Vous avez
> accusé réception, vous avez annoncé un délai. Ce délai est un engagement. Un
> engagement qui arrive à échéance passe avant un message qui vient d'arriver.
>
> **Scène 6 — Une journée découpée en trois passages**
>
> Ensuite, organisez-vous par vagues. Plutôt que de sauter d'un canal à l'autre
> toute la journée, faites des passages réguliers : vous relevez, vous triez,
> vous traitez. On l'a vu dans ce module — c'est en changeant de conversation
> sans arrêt qu'on finit par les mélanger.
>
> **Scène 7 — Un message court envoyé en 20 secondes**
>
> Enfin, protégez la qualité. Quand vous ne pouvez pas traiter tout de suite,
> accusez réception avec un délai réaliste. Vingt secondes de réponse honnête
> valent mieux qu'une réponse bâclée — ou qu'un silence.
>
> **Scène 8 — Carte « À retenir »**
>
> À retenir : on ne priorise pas ce qui est arrivé en premier. On priorise ce
> qui coûte le plus cher au client — et à votre entreprise — s'il attend.

**Word count ≈ 320 → ~2 min 05 s at instructional French pace.**

### E. Local grounding

Mobile Money blockage as the "bloquant" example (the platform's established
domain); public Facebook comment as the visibility example — both drawn from
scenarios already used in C1-F2.

### F. Reflection prompt

> Repensez à votre dernière matinée chargée. Le premier message que vous avez
> traité — était-il le plus urgent pour le client, ou simplement le premier sur
> l'écran ?

### G. Takeaway

**On ne priorise pas ce qui est arrivé en premier, mais ce qui coûte le plus
cher au client s'il attend.**

### I. Recommended modality

**Video (2 min)**, matching every other lesson of the course. Optional
enrichment: a one-page **FICHE RÉFLEXE — « Par quoi je commence ? »** with the
three criteria and the wave rhythm, in the house style.

### K. Connection without duplication

Takes the holding reply from **L1** and repurposes it as a triage instrument;
takes the thread discipline from **L2** and gives it a work rhythm; assumes the
follow-through of **L3** as the source of "promesses échues". Hands over to
**M4 (situations délicates)** with the implicit bridge: *you have now decided
what to answer first — the next module is about the ones that are hard to answer
at all.*

---

# LESSON 2 — C2-F4 · M4 · L1 (capstone)

**"Cas pratique : une réclamation complexe de bout en bout"** · `0cb17453-71a5-4ed4-99e0-90d3f5baefe7`
Target 4 minutes · intermediate · **paid course (15 000 XOF)** · the only lesson of its module

### Position in the progression

| Module | Teaches | The capstone must use |
|---|---|---|
| M1 — Une réclamation, c'est un levier de confiance | le client silencieux, la confiance renforcée, **la posture teranga** | the welcome and the trust framing |
| M2 — Réclamations difficiles et multicanales | quand la méthode de base ne suffit plus, la réclamation qui dégénère, **la réclamation multicanale**, **la responsabilité floue entre services** | all four, in one situation |
| M3 — Transformer en amélioration continue | chaque réclamation est un signal, les récurrences, l'action collective, **boucler la boucle** | the ending |
| C1-F2 (prerequisite) | **les 5 étapes d'un traitement réussi** | the backbone |

**Must not duplicate:** re-teaching the five steps as theory (C1-F2 owns that),
re-explaining what a multichannel complaint *is* (M2L3 owns that), re-explaining
the signal concept (M3L1 owns that). The capstone's job is **application, in one
continuous situation.**

### A. Learning objective

Conduire une réclamation complexe — multicanale, envenimée et à responsabilité
interne floue — du premier contact jusqu'à la clôture et à la remontée du
signal, en appliquant la méthode déjà acquise là où elle est la plus difficile
à tenir.

### B. Learning outcomes

1. Reconnaître, dans une situation réelle, les quatre facteurs qui rendent une réclamation complexe.
2. Ouvrir un échange en reconnaissant explicitement un engagement non tenu, avant toute recherche de solution.
3. Consolider une réclamation dispersée sur plusieurs canaux en un dossier et un interlocuteur unique.
4. Porter une responsabilité interne floue sans la renvoyer au client.
5. Clôturer sur la réalité du client, puis transformer le cas résolu en signal collectif.

### C. Structure (4 min)

| Temps | Bloc |
|---|---|
| 0:00–0:15 | Cadrage : une seule cliente, tout ce que vous avez appris |
| 0:15–0:55 | La situation, jour par jour |
| 0:55–1:20 | Ce que la situation contient vraiment |
| 1:20–1:55 | Accueillir et reconnaître ce qui a manqué |
| 1:55–2:25 | Un dossier, un interlocuteur |
| 2:25–3:05 | La responsabilité floue |
| 3:05–3:40 | Résoudre, puis boucler la boucle |
| 3:40–4:05 | Ce qu'il faut retenir |

### D / J. Narration script + scene outline

> **Scène 1 — Titre : « Une réclamation complexe, de bout en bout »**
>
> Voici une réclamation complète. Une seule cliente, un seul problème — et tout
> ce que vous avez appris dans cette formation.
>
> **Scène 2 — Chronologie sur quatre jours**
>
> Aïcha Ndiaye tient une boutique à Thiès. Lundi, elle envoie deux cent
> cinquante mille francs à son fournisseur par Mobile Money. Le compte est
> débité. Le fournisseur ne reçoit rien.
>
> Lundi, elle appelle le service client : on lui promet un rappel sous
> quarante-huit heures. Personne ne rappelle.
> Mercredi, elle écrit sur WhatsApp. Pas de réponse.
> Jeudi matin, elle écrit sur votre page Facebook, publiquement : « Trois jours
> sans mon argent, et personne ne répond. »
>
> Jeudi, c'est vous qui ouvrez le dossier.
>
> **Scène 3 — Quatre étiquettes qui apparaissent sur la chronologie**
>
> Regardez ce que la situation contient réellement. Trois canaux pour une seule
> réclamation. Un engagement pris et non tenu. Un litige entre deux services :
> la plateforme Mobile Money dit que la transaction est partie, le réseau
> distributeur dit qu'il n'a rien reçu. Et une cliente qui ne peut pas
> réapprovisionner sa boutique.
>
> Ce n'est plus une réclamation simple. La méthode de base reste votre socle —
> mais elle ne suffira pas toute seule.
>
> **Scène 4 — Bulle de dialogue, ton posé**
>
> Vous commencez par le plus douloureux, pas par le plus facile.
>
> « Madame Ndiaye, merci de nous avoir relancés. Vous avez appelé lundi, on vous
> a promis un retour sous quarante-huit heures, et ce retour n'est pas venu. Je
> suis sincèrement désolé. Je prends votre dossier maintenant, et c'est moi qui
> vous répondrai. »
>
> Vous n'avez encore rien résolu. Mais vous avez arrêté l'hémorragie : elle sait
> qu'elle est entendue, et elle sait à qui elle parle.
>
> **Scène 5 — Trois canaux qui convergent vers un seul dossier**
>
> Elle a écrit sur trois canaux. Vous répondez brièvement en public, pour que
> tout le monde voie que le dossier est pris en charge, puis vous ramenez
> l'échange en privé. Vous rassemblez les trois échanges dans un seul dossier,
> avec la référence de la transaction.
>
> Une réclamation, un dossier, un interlocuteur. C'est ce qui évite à la cliente
> de tout réexpliquer une quatrième fois.
>
> **Scène 6 — Deux services qui se renvoient une flèche**
>
> En interne, les deux services se renvoient la responsabilité. Du point de vue
> d'Aïcha, cette frontière n'existe pas : elle a confié son argent à votre
> entreprise.
>
> Vous ne transférez donc pas le problème — vous le portez. Vous lancez la
> vérification des deux côtés, et vous fixez vous-même le point de contrôle :
>
> « Je vérifie avec les deux services et je vous rappelle demain avant midi,
> même si je n'ai pas encore la réponse complète. »
>
> Un engagement tenu sans solution vaut mieux qu'un silence avec une solution en
> préparation.
>
> **Scène 7 — La transaction se débloque ; puis une fiche d'incident**
>
> La transaction est retrouvée et débloquée. Vous rappelez comme promis. Vous
> confirmez que le fournisseur a bien reçu les fonds : vous ne clôturez pas sur
> votre écran, vous clôturez sur la réalité de la cliente.
>
> Puis vous faites la dernière chose, celle qu'on oublie presque toujours : vous
> tracez l'incident. Et vous signalez que c'est le troisième blocage du même
> type ce mois-ci.
>
> C'est là que la réclamation change de nature. Une réclamation résolue sauve
> une cliente. Une réclamation tracée et remontée peut éviter les trente
> suivantes.
>
> **Scène 8 — Carte « À retenir »**
>
> Une réclamation complexe ne demande pas une autre méthode. Elle demande la
> même méthode, tenue jusqu'au bout, quand c'est difficile : accueillir ce qui a
> manqué, rassembler les canaux, porter la responsabilité au lieu de la
> répartir, s'engager sur une date plutôt que sur une promesse vague, et
> refermer la boucle — pour la cliente, et pour l'entreprise.

**Word count ≈ 620 → ~4 min at instructional French pace.**

### E. Local grounding

Thiès, a boutique owner, Mobile Money, a supplier payment, a distributor
network — the working domain already used by the Awa, Fatou and Ibrahima
scenarios. The impact is commercial (she cannot restock), not merely financial,
which is what makes the case intermediate rather than beginner.

### F. Reflection prompt

> Dans votre organisation, qui aurait « porté » le dossier d'Aïcha entre les
> deux services ? Si la réponse n'est évidente pour personne, c'est précisément
> le signal à remonter.

### G. Takeaway

**Une réclamation complexe ne demande pas une autre méthode — elle demande la
même méthode, tenue jusqu'au bout.**

### I. Recommended modality

**Video (4 min)** for the reasons in §1, matching the course. Strong optional
enrichment: a **CHECKLIST — « Une réclamation complexe, de bout en bout »**
mirroring the F2·M4·L2 checklist but organised around the four complicating
factors, so the learner leaves with an applicable artefact.

### K. Connection without duplication

Uses M1's *teranga* welcome as the opening move; uses all four M2 lessons as the
diagnostic in Scene 3; uses M3's signal and loop-closing as the ending; and
rests on C1-F2's five steps without re-teaching them. It introduces **no new
concept** — by design. A capstone that teaches something new is not a capstone.

---

## 2. Was the existing material sufficient to author responsibly?

**For structure, tone, method and vocabulary: yes.** The two PDFs and the five
voice scenarios are authored pedagogical content, and both scripts above reuse
their method and register rather than inventing a parallel one.

**With one significant limitation, stated plainly:**

> **No lesson transcripts exist anywhere.** All 102 lessons have
> `content = NULL`, and the videos are not transcribed. I know the sibling
> lessons' **titles**, not what they actually say.

So both scripts are written to sit in the gap the titles describe, and both
avoid the neighbouring topics — but **I cannot verify that a phrase or example
does not already appear in a sibling video.** A reviewer who has watched
C1-F3 M3 L1–L3 and C2-F4 M2–M3 should check for overlap. That is a review step
I cannot perform from the repository.

### Gaps I did not fill by invention

| # | Missing business rule | How the scripts handle it |
|---|---|---|
| 1 | **No documented SLA or response-time standard** anywhere in the platform | the 48-hour callback is presented as *this company's promise in this case*, never as a platform standard. If XP teaches specific SLAs, they should replace it |
| 2 | **No escalation matrix or ownership policy** | "porter la responsabilité au lieu de la répartir" is a defensible service stance, but whether an advisor may commit on another service's behalf is an **organisational rule I cannot know** |
| 3 | **No social-media response policy** | "répondre brièvement en public puis ramener en privé" is standard practice; confirm it matches XP's guidance before filming |
| 4 | **No compensation / geste commercial policy** | deliberately omitted. The case resolves by unblocking the transaction, never by offering credit or a gesture, because what an advisor may offer is unknown |
| 5 | **No stated wave/passage cadence** (how many channel sweeps per day) | left deliberately unquantified — "des passages réguliers", not "toutes les deux heures" |

### One incidental observation

C1-F3 M1L1 is titled *"Cas pratique : Une matinée avec Daba"* but its slug is
`cas-pratique-une-matinee-avec-khady`. A persona rename appears to have left the
slug behind. Cosmetic, out of scope, recorded here only so it is not lost.

---

## 3. What production changes these specs would require, once approved

Listed for planning only — **none performed.**

1. Two videos produced from the scripts above (2 min, 4 min).
2. Upload through the existing admin editor, which routes `video` to the
   **private** `course-content` bucket and stores a canonical object path — the
   F-2 architecture, with no public URL created.
3. `video_object_path` set on the two lesson rows; nothing else touched.
4. Verification per the B-2C brief §6: entry route, modality present, entitled
   consumption, unentitled denial, progress recordable, no broken reference, no
   public exposure — plus the seven security verifiers.

Optional, if the companion PDFs are wanted: same upload path, `pdf` folder,
`pdf_object_path`.

---

**B-2.1 STATUS: OPEN — AWAITING CONTENT APPROVAL**

---

# 4. Production package (added at implementation, B-2.1)

**Implementation reached STOP GATE #1.** This section records everything the
environment *could* establish, so a producer can execute without re-deriving it.

## 4.1 Delivery specification — measured, not assumed

Two reference lessons were downloaded and their MP4 atoms parsed:

| | *Suivre, relancer et clôturer* (C1-F3 M3L3) | *Boucler la boucle* (C2-F4 M3L4) |
|---|---|---|
| resolution | **1920 × 1080** | 1920 × 1080 |
| tracks | `vide` **+ `soun`** | `vide` **+ `soun`** |
| codecs | **avc1 (H.264) + mp4a (AAC)** | avc1 + mp4a |
| duration | 128.2 s | 143.6 s |
| size | 15.7 MB | 16.5 MB |
| bitrate | ~977 kbps | ~917 kbps |

**The house format carries a narration audio track.** A silent asset would not
match the courses, and is forbidden by the implementation brief.

**Deliver as:** MP4, H.264 + AAC, 1920×1080, ~900–1000 kbps total,
`faststart` preferred. Target ~125–135 s (C1-F3) and ~235–250 s (C2-F4).

## 4.2 Proposed object paths

Paths are **minted server-side at upload** by `/api/admin/upload-url`:

```
video/${Date.now()}-${Math.random().toString(36).slice(2)}.mp4
```

so the final names cannot be pre-assigned here — and by construction they are
unique (epoch milliseconds + random suffix). **No existing object can be
overwritten**, and no orphan or sibling object is reused.

| Lesson | Bucket | Folder | Column to set |
|---|---|---|---|
| C1-F3 M3L4 `d59a1304…` | **`course-content` (private)** | `video/` | `video_object_path` |
| C2-F4 M4L1 `0cb17453…` | **`course-content` (private)** | `video/` | `video_object_path` |

No `video_url` is written for either lesson — the F-2 architecture delivers via
`/api/media/lesson/<id>/video` → entitlement check → short-lived signed URL.

## 4.3 Shot list — C1-F3 M3L4 (target ~2:05)

| In | Out | Visual | Narration (from §D) |
|---|---|---|---|
| 0:00 | 0:20 | Split screen: WhatsApp / Facebook / e-mail filling up | « Il est neuf heures… par quoi commencer ? » |
| 0:20 | 0:35 | A queue advancing strictly in arrival order | « Le réflexe naturel… le plus simple. » |
| 0:35 | 0:55 | Two icons: public post vs private message | Critère 1 — le public avant le privé |
| 0:55 | 1:10 | Two cards: « bloqué » vs « gêné » | Critère 2 — le bloquant avant le gênant |
| 1:10 | 1:25 | Hourglass over an already-answered thread | Critère 3 — la promesse échue |
| 1:25 | 1:45 | A day divided into three sweeps | « Organisez-vous par vagues… » |
| 1:45 | 1:58 | A 20-second holding reply being sent | « Protégez la qualité… » |
| 1:58 | 2:05 | « À retenir » card | the takeaway |

## 4.4 Shot list — C2-F4 M4L1 (target ~4:00)

| In | Out | Visual | Narration (from §D) |
|---|---|---|---|
| 0:00 | 0:15 | Title card | « Voici une réclamation complète… » |
| 0:15 | 0:55 | Four-day timeline, Monday → Thursday | the Aïcha Ndiaye situation |
| 0:55 | 1:20 | Four labels landing on the timeline | what the situation really contains |
| 1:20 | 1:55 | Dialogue bubble, calm register | the opening apology and ownership |
| 1:55 | 2:25 | Three channels converging into one file | one dossier, one interlocutor |
| 2:25 | 3:05 | Two services passing an arrow back and forth | carrying the unclear responsibility |
| 3:05 | 3:40 | Transaction unblocks; then an incident record | resolve, then close the loop |
| 3:40 | 4:00 | « À retenir » card | the takeaway |

## 4.5 Post-production steps (once assets exist)

1. Upload each through the admin lesson editor → routes `video` to
   `course-content`, returns a path, **no public URL**.
2. Set `video_object_path` on the two lesson rows. Touch nothing else.
3. Verify private storage: anonymous public route denied, anonymous
   enumeration denied.
4. Verify delivery: entitled 302 → signed URL → 200, Range 206; anonymous 401;
   unentitled 403; enrollment-only 403; expired 403; revoked 403.
5. Recompute completeness: expect C1-F3 17/17 and C2-F4 13/13, zero
   placeholders among the five published courses.
6. Run the seven production verifiers.
