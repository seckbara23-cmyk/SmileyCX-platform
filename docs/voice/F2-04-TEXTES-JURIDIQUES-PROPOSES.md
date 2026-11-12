# Entraînement vocal · textes proposés pour la confidentialité et le consentement

**Statut : propositions, non publiées, non relues par un juriste.** Les pages légales en ligne restent en version 1.0 et disent que l'entraînement vocal n'est pas ouvert. Rien ci-dessous n'est en service.

Décisions du propriétaire intégrées (12 novembre 2026) :
- **D1** : les contenus vocaux sont conservés 30 jours ;
- **D2** : retirer son accord arrête tout nouveau traitement et déclenche la suppression des données vocales existantes, y compris la demande de suppression chez le prestataire ;
- **D3** : supprimer ses données vocales ne redonne pas d'essais ; la limite de cinq essais par leçon et par période d'accès est conservée.

Les passages entre crochets restent à confirmer.

## 1. Politique de confidentialité, article 6 (remplace le texte actuel)

> **6. L'entraînement vocal**
>
> Dans la formation C1-F2, vous pouvez vous entraîner à l'oral avec un client simulé. Cet entraînement est facultatif : sans lui, le reste de la formation reste entièrement accessible.
>
> **Ce qui est traité.** Pendant l'exercice, votre micro capte votre voix. Notre prestataire de conversation vocale, ElevenLabs, la traite pour faire parler le client simulé, transcrire l'échange et produire une analyse de l'entraînement. La plateforme enregistre la transcription de l'échange et le retour qui vous est présenté. [Selon l'exercice, une analyse par intelligence artificielle (Anthropic) peut compléter ce retour.]
>
> **Votre accord.** L'entraînement vocal ne commence qu'après votre accord explicite, donné sur l'écran de l'exercice.
>
> **Durée de conservation.** Les transcriptions, les retours et les conversations sont supprimés 30 jours après l'entraînement, sur la plateforme, et une demande de suppression est adressée à ElevenLabs au même moment. ElevenLabs est par ailleurs configuré pour ne pas conserver ces conversations plus de 30 jours.
>
> **Le décompte des essais.** Pour appliquer la limite de cinq essais par leçon pendant votre période d'accès, la plateforme garde, pour chaque essai, la date, la leçon et votre compte, sans aucune de vos paroles. Ce décompte est conservé même si vous supprimez vos données vocales, et il est supprimé avec votre compte.
>
> **Retirer votre accord.** Sous chaque exercice vocal, « Mes données vocales » vous permet de retirer votre accord à tout moment. Le retrait arrête immédiatement tout nouveau traitement de votre voix et supprime vos entraînements vocaux. Vous pouvez aussi supprimer vos entraînements en gardant votre accord, ou nous écrire à [adresse de contact].
>
> **Ce que veut dire « supprimé ».** La suppression est immédiate sur la plateforme. Chez ElevenLabs, la demande est envoyée au même moment. Si elle n'aboutit pas, elle est relancée automatiquement jusqu'à son terme, et l'écran vous indique que la suppression chez le prestataire est en cours.
>
> **Limites.** Des copies de sauvegarde de la plateforme peuvent subsister au plus 7 jours après une suppression, avant d'être écrasées. ElevenLabs peut conserver des copies techniques selon ses propres conditions : [à compléter après la réponse écrite d'ElevenLabs].
>
> **Suppression de votre compte.** Si votre compte est supprimé, vos entraînements vocaux et le décompte de vos essais le sont aussi, sur la plateforme, et une demande de suppression est adressée à ElevenLabs selon les mêmes règles.

## 2. Écran de consentement, version voix-1.1 (préparée, non active)

La version active en code reste **voix-1.0**. La version voix-1.1 est préparée dans le code (`VOICE_CONSENT_NEXT`), sans être utilisée. L'activer est un changement d'une ligne, fait avec la publication des pages légales. Les personnes qui ont accepté voix-1.0 devront accepter voix-1.1 avant leur prochain entraînement.

> J'accepte que ma voix et le texte de mes échanges soient traités par ElevenLabs pour simuler le client et me donner un retour[, et, selon l'exercice, par Anthropic pour analyser mon entraînement]. Mes transcriptions et mes retours sont conservés 30 jours. Je peux retirer cet accord à tout moment depuis « Mes données vocales » : le traitement s'arrête et mes entraînements vocaux sont supprimés. Le nombre d'essais déjà utilisés reste décompté.

La case reste décochée par défaut, et le lien vers l'article 6 reste affiché à côté.

## 3. Messages de « Mes données vocales » (en code, non visibles tant que l'entraînement est fermé)

| Situation | Message |
|---|---|
| Présentation | Retirer votre accord arrête le traitement de votre voix et supprime vos entraînements vocaux (transcriptions et retours). Vous pouvez aussi supprimer ces données en gardant votre accord. Votre progression et le nombre d'essais déjà utilisés sont conservés. |
| Confirmation du retrait | Retirer votre accord et supprimer vos entraînements vocaux ? |
| Retrait, suppression complète | Votre accord est retiré et vos entraînements vocaux sont supprimés, sur la plateforme et chez notre prestataire vocal. |
| Retrait, suppression en attente chez le prestataire | Votre accord est retiré et vos entraînements vocaux sont supprimés de la plateforme. La suppression chez notre prestataire vocal n'a pas encore abouti pour une partie d'entre eux : elle est relancée automatiquement jusqu'à son terme. |
| Retrait enregistré, suppression échouée | Votre accord est retiré, mais la suppression de vos données vocales n'a pas pu être effectuée. Réessayez. |
| Suppression complète | Vos entraînements vocaux sont supprimés, sur la plateforme et chez notre prestataire vocal. |
| Suppression en attente | Vos entraînements sont supprimés de la plateforme. La suppression chez notre prestataire vocal n'a pas encore abouti pour une partie d'entre eux : elle est relancée automatiquement jusqu'à son terme. |
| Échec | La suppression n'a pas pu être effectuée. |
| Entraînement expiré | Le détail de cet entraînement n'est plus conservé. |

## 4. Autres pages à mettre à jour dans la même version

- **CGU, article 7** : remplacer « n'est pas encore ouvert » par le fonctionnement réel, avec renvoi à l'article 6 de la politique de confidentialité.
- **CGV, article 8** : cinq essais par leçon pendant la période d'accès ; un nouvel accès ouvre une nouvelle période ; supprimer ses données vocales ne redonne pas d'essais.
- **Politique de confidentialité, tableau des données** : « Transcription et retour de l'entraînement vocal », conservés 30 jours ; « Décompte des essais », conservé jusqu'à la suppression du compte.
- **Tableau des prestataires** : ElevenLabs, conservation réglée à 30 jours.

## 5. Points à faire relire par un juriste

Aucune approbation juridique n'a eu lieu. Ces points sont des questions, pas des conclusions.

1. **Loi sénégalaise n° 2008-12 du 25 janvier 2008** sur la protection des données à caractère personnel, et son décret d'application. Vérifier aussi si un texte plus récent est en vigueur à la date de publication.
2. **Formalités auprès de la CDP.** Le traitement de la voix et des transcriptions demande-t-il une déclaration, ou une autorisation, de la Commission de protection des données personnelles ?
3. **Transferts hors du Sénégal.** ElevenLabs et Anthropic traitent les données hors du Sénégal. Il faut confirmer les conditions de ces transferts et l'éventuelle autorisation préalable.
4. **Nature de la voix.** Confirmer que la voix, utilisée ici pour la conversation et sans identification de la personne, n'est pas traitée comme une donnée biométrique ou sensible.
5. **Décompte des essais conservé après une suppression (D3).** Il faut confirmer la base légale : l'exécution du contrat, dont la limite d'essais fait partie. Il faut aussi confirmer la durée : aujourd'hui jusqu'à la suppression du compte. Une durée plus courte, limitée à la période d'accès, est possible si elle est préférée. Ce décompte n'est pas anonyme : il est rattaché au compte.
6. **Retrait qui supprime (D2).** Le retrait d'un consentement n'oblige pas toujours à supprimer. Ici, la suppression est un choix plus protecteur. Vérifier que le texte ne promet pas plus que ce qui est fait chez le prestataire.
7. **Sauvegardes de 7 jours et copies chez le prestataire** : la manière de les présenter.
8. **Durée de 30 jours** : sa proportionnalité au regard de la finalité.

## 6. Recette restreinte avant publication

Une recette avec un compte nommé peut précéder la publication. Il faut que la personne qui teste accepte l'écran actuel (voix-1.0) en connaissance de cause, et qu'elle supprime ses données à la fin. C'est une décision du propriétaire.
