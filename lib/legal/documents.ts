/**
 * The four public legal texts of XP Client Academy, version 1.0 — XP-LAUNCH-FINAL-11.
 *
 * Source: the documents XP CLIENT shared on 2026-11-08 (CGU/CGV v0.3, privacy
 * policy v0.2, legal notice v0.2), each « candidat à la version publiée 1.0 ».
 * Only their PUBLIC parts are transcribed here, word for word: the internal
 * pages (decisions, questions for the lawyer, what the platform must do, items
 * to confirm) and the working notes are left out, as the documents themselves
 * instruct. Nothing is reworded here; a change to a text is a new version.
 *
 * These texts were drafted with the help of AI tools and have NOT been reviewed
 * by a lawyer yet (review planned by 2026-11-23). Nothing on the pages may say
 * otherwise; see `LEGAL_TEXT_PENDING_REVIEW` in ./versions.
 *
 * Inline markup: **bold** and *italic*. E-mail addresses become mailto links.
 * The contact address and phone are read from `@/lib/brand`, the single source
 * every display surface uses (XPA-1); their values are the ones the documents give.
 *
 * Client-safe (no server import) so server components and tests can import it.
 */
import { CONTACT_EMAIL, CONTACT_PHONE } from '@/lib/brand'

export type LegalBlock =
  | { readonly p: string }
  | { readonly ul: readonly string[] }
  | { readonly ol: readonly string[] }
  | { readonly h3: string }
  | { readonly table: { readonly head: readonly string[]; readonly rows: readonly (readonly string[])[] } }

export interface LegalSection {
  readonly id: string
  readonly title: string
  readonly blocks: readonly LegalBlock[]
}

export interface LegalText {
  readonly title: string
  readonly version: string
  readonly dated: string
  readonly intro: readonly LegalBlock[]
  readonly sections: readonly LegalSection[]
}

// ── Partie A — Conditions générales d'utilisation ───────────────────────────

export const CGU: LegalText = {
  title: 'Conditions générales d’utilisation (CGU)',
  version: '1.0',
  dated: 'novembre 2026',
  intro: [],
  sections: [
    {
      id: 'article-1',
      title: 'Article 1 — Qui sommes-nous',
      blocks: [
        { p: 'La plateforme XP Client Academy est éditée par **XP CLIENT, SUARL** (société unipersonnelle à responsabilité limitée).' },
        { ul: [
          'Nom commercial : XP Client Consulting',
          'Siège : Ngor Cité SOCABEG, villa n° 16, Dakar (Sénégal)',
          'Capital social : 150 000 FCFA',
          'RCCM : SN.DKR.2026.B.38780 — NINEA : 013427788',
          'Gérante et directrice de la publication : Marième BA',
          `Contact : ${CONTACT_EMAIL} — WhatsApp : ${CONTACT_PHONE}`,
          'Hébergement du site : Vercel Inc. Base de données et fichiers pédagogiques : Supabase. La liste de nos prestataires figure à l’article 10.',
        ] },
        { p: 'Dans ce document, « XP » désigne XP CLIENT SUARL. « Vous » désigne la personne qui utilise la plateforme.' },
      ],
    },
    {
      id: 'article-2',
      title: 'Article 2 — À quoi servent ces CGU',
      blocks: [
        { p: 'Ces CGU expliquent les règles d’utilisation de la plateforme XP Client Academy : formations en ligne sur l’expérience client, le service client et la culture client. En créant un compte ou en utilisant la plateforme, vous les acceptez.' },
      ],
    },
    {
      id: 'article-3',
      title: 'Article 3 — Votre compte',
      blocks: [
        { ul: [
          'L’achat est réservé aux personnes majeures (18 ans ou plus). Un mineur peut suivre une formation avec l’autorisation de son parent ou représentant légal, qui effectue l’achat (voir CGV, article 9).',
          'Les informations que vous donnez doivent être exactes et à jour.',
          'Un compte correspond à une seule personne. Vous ne le partagez pas et vous gardez vos identifiants confidentiels.',
          'Si vous pensez que quelqu’un utilise votre compte, prévenez-nous rapidement.',
        ] },
      ],
    },
    {
      id: 'article-4',
      title: 'Article 4 — Ce que vous pouvez faire des contenus',
      blocks: [
        { p: 'Les formations, vidéos, textes, quiz, exercices, documents à télécharger, images et voix appartiennent à XP ou sont utilisés avec autorisation. Avec une formation payante, vous recevez un droit d’usage **personnel, non exclusif et non transférable**, pendant la durée de votre accès.' },
        { p: 'Vous ne pouvez pas : copier, revendre, diffuser ou publier les contenus ; enregistrer ou extraire les vidéos ; prêter votre accès à d’autres personnes ; utiliser les contenus pour entraîner un système d’intelligence artificielle. Les documents que vous téléchargez restent utilisables pour votre travail personnel après la fin de l’accès.' },
      ],
    },
    {
      id: 'article-5',
      title: 'Article 5 — Bonne conduite',
      blocks: [
        { p: 'Soyez respectueux. Vous vous engagez à ne pas tenter de contourner la sécurité de la plateforme, à ne pas déposer de contenu illégal, injurieux ou qui porte atteinte aux droits d’autrui, et à ne pas perturber le service.' },
      ],
    },
    {
      id: 'article-6',
      title: 'Article 6 — Certificats',
      blocks: [
        { p: 'Lorsque vous avez suivi toutes les leçons d’une formation et, si cette formation comporte une évaluation finale, après l’avoir réussie, vous pouvez obtenir un certificat XP. Il atteste que vous avez suivi la formation jusqu’au bout et, le cas échéant, réussi son évaluation finale. Il peut être vérifié en ligne grâce à son QR code. **Il ne s’agit ni d’un diplôme d’État ni d’une certification reconnue par une autorité externe.** Un certificat déjà obtenu reste valide après la fin de votre accès à la formation.' },
      ],
    },
    {
      id: 'article-7',
      title: 'Article 7 — Entraînement vocal',
      blocks: [
        { p: `L’entraînement vocal de la formation C1-F2 n’est pas encore ouvert. Lorsqu’il le sera, vous parlerez à un client simulé et recevrez un retour : votre voix et le texte de l’échange seront traités par notre prestataire de conversation vocale (ElevenLabs), la plateforme pourra enregistrer la transcription de l’échange et l’évaluation de votre entraînement, et une analyse par intelligence artificielle (Anthropic) pourra être utilisée pour cette évaluation. Vous pourrez demander la suppression de ces données en écrivant à ${CONTACT_EMAIL}.` },
        { p: 'Ses conditions, dont le nombre d’essais inclus, seront publiées dans une nouvelle version des présentes conditions avant son ouverture, et vous ne pourrez l’utiliser qu’après avoir accepté ce traitement. Cet entraînement est un outil d’apprentissage ; il ne remplace pas une évaluation professionnelle.' },
      ],
    },
    {
      id: 'article-8',
      title: 'Article 8 — Disponibilité de la plateforme',
      blocks: [
        { p: 'Nous faisons le maximum pour que la plateforme soit accessible en continu. Des coupures peuvent survenir (maintenance, panne, problème de réseau ou de prestataire). Nous ne pouvons pas garantir un accès sans interruption. Si une indisponibilité importante vous a empêché de suivre votre formation, écrivez-nous : nous examinerons avec vous une prolongation de votre accès.' },
      ],
    },
    {
      id: 'article-9',
      title: 'Article 9 — Ce que XP promet, et ce que XP ne promet pas',
      blocks: [
        { p: 'Nos formations visent à développer vos connaissances et vos pratiques. **XP ne garantit aucun résultat professionnel** : ni emploi, ni promotion, ni amélioration chiffrée d’indicateurs dans votre entreprise. Dans les limites permises par la loi, la responsabilité de XP est limitée aux dommages directs et ne dépasse pas le prix payé pour la formation concernée. Cette limite ne s’applique pas dans les cas où la loi l’interdit.' },
      ],
    },
    {
      id: 'article-10',
      title: 'Article 10 — Vos données personnelles',
      blocks: [
        { p: 'Nous collectons les données nécessaires au service : identité, e-mail, téléphone, entreprise le cas échéant, progression, résultats, certificats, et informations liées au paiement (le paiement est traité par notre prestataire, voir les CGV). Nous les utilisons pour gérer votre compte, vous donner accès aux formations, délivrer vos certificats, assurer le support et améliorer la plateforme.' },
        { p: 'Pour fonctionner, la plateforme s’appuie sur des prestataires techniques, dont certains sont situés hors du Sénégal. Vos données peuvent donc être traitées hors du Sénégal. Nous ne transmettons à ces prestataires que ce qui est nécessaire au service.' },
        { table: {
          head: ['Service', 'Prestataire', 'À quoi il sert'],
          rows: [
            ['Hébergement du site', 'Vercel', 'Faire fonctionner le site'],
            ['Comptes, base de données, fichiers pédagogiques', 'Supabase', 'Conserver vos données, votre progression et les contenus'],
            ['E-mails de la plateforme', 'Resend', 'Envoyer les confirmations et messages'],
            ['Paiement en ligne', 'PayTech', 'Traiter les paiements Wave, Orange Money et carte'],
            ['Entraînement vocal', 'ElevenLabs', 'Conduire la conversation avec le client simulé'],
            ['Évaluation par intelligence artificielle', 'Anthropic', 'Aider à évaluer certains exercices, selon les formations'],
          ],
        } },
        { p: `Vous pouvez demander l’accès à vos données, leur correction ou leur suppression en écrivant à ${CONTACT_EMAIL}. Nous vérifions votre identité, traitons votre demande et répondons dans un délai de 30 jours. Certaines données doivent toutefois être conservées pour des raisons légales, comptables ou de preuve.` },
        { p: 'La plateforme utilise les mécanismes de session nécessaires à votre connexion. Le détail figure dans notre politique de confidentialité, qui décrit aussi les données collectées et vos droits. Les données sont traitées conformément à la loi n° 2008-12 du 25 janvier 2008 sur la protection des données à caractère personnel.' },
        { p: 'Si votre accès vous est fourni par votre entreprise, elle peut voir votre progression, vos résultats et vos certificats pour les formations qu’elle vous a attribuées. Elle doit vous en informer.' },
      ],
    },
    {
      id: 'article-11',
      title: 'Article 11 — Suspension du compte',
      blocks: [
        { p: 'En cas de non-respect de ces CGU (par exemple partage de compte ou copie des contenus), XP peut suspendre ou fermer le compte, après vous avoir prévenu lorsque c’est possible. Aucun remboursement n’est dû dans ce cas, sauf si la loi en dispose autrement.' },
      ],
    },
    {
      id: 'article-12',
      title: 'Article 12 — Modification des CGU',
      blocks: [
        { p: 'Nous pouvons modifier ces CGU. La nouvelle version s’applique à partir de sa publication, et vous serez informé des changements importants. Les achats déjà faits restent soumis aux CGV en vigueur au moment de l’achat.' },
      ],
    },
    {
      id: 'article-13',
      title: 'Article 13 — Droit applicable et litiges',
      blocks: [
        { p: 'Ces CGU sont soumises au droit sénégalais. En cas de difficulté, contactez-nous d’abord : nous cherchons une solution à l’amiable. À défaut, les tribunaux compétents de Dakar seront saisis, sous réserve des règles qui protègent le consommateur.' },
      ],
    },
  ],
}

// ── Partie B — Conditions générales de vente ────────────────────────────────

export const CGV: LegalText = {
  title: 'Conditions générales de vente (CGV)',
  version: '1.0',
  dated: 'novembre 2026',
  intro: [],
  sections: [
    {
      id: 'article-1',
      title: 'Article 1 — Champ d’application',
      blocks: [
        { p: 'Ces CGV s’appliquent à toute vente de formations en ligne par XP CLIENT SUARL (voir l’article 1 des CGU pour l’identité de XP) : achat d’une formation, achat d’un pack, ou commande de licences d’équipe. Elles complètent les CGU. Le « Client » est la personne ou l’entreprise qui commande. L’« Apprenant » est la personne qui suit la formation.' },
      ],
    },
    {
      id: 'article-2',
      title: 'Article 2 — Nos offres et nos prix',
      blocks: [
        { p: 'Les prix sont indiqués en francs CFA (FCFA). Pour les particuliers, le prix affiché est le prix à payer, sans frais supplémentaires.' },
        { table: {
          head: ['Code', 'Formation', 'Prix (FCFA)'],
          rows: [
            ['C1-F1', 'Fondamentaux de l’expérience client', '9 900'],
            ['C1-F2', 'Fondamentaux du service client', '9 900'],
            ['C1-F3', 'Communiquer avec les clients sur les canaux digitaux', '9 900'],
            ['C2-F4', 'Gérer les réclamations et transformer l’insatisfaction en opportunité', '14 900'],
            ['C2-F1', 'Manager une équipe orientée client', '14 900'],
            ['C2-F2', 'Mesurer l’expérience client', '14 900'],
            ['C2-F5', 'Développer une culture client', '14 900'],
            ['C1-F4', 'Donnez envie à vos clients de revenir', 'Gratuite'],
          ],
        } },
        { p: 'Chaque formation s’achète seule. Aucune formation n’est obligatoire avant une autre : C1-F1 est recommandée pour débuter, mais elle n’est pas une condition d’achat. Les formations non encore disponibles ne peuvent pas être achetées et sont signalées « Bientôt disponible ».' },
        { p: 'XP peut modifier ses prix à tout moment. Le prix applicable est celui affiché au moment de la commande.' },
      ],
    },
    {
      id: 'article-3',
      title: 'Article 3 — Les packs',
      blocks: [
        { table: {
          head: ['Pack', 'Composition', 'Prix (FCFA)'],
          rows: [
            ['Pack Conseiller', 'C1-F1 + C1-F2 + C1-F3 + C2-F4', '37 900'],
            ['Pack Manager', 'C2-F1 + C2-F2 + C2-F5', '38 000'],
          ],
        } },
        { p: 'Un pack est facultatif : il ouvre l’accès aux formations qui le composent, à un prix inférieur à l’achat séparé. Il ne crée aucune obligation d’acheter un pack pour suivre une formation. Le prix d’un pack n’est pas cumulable avec d’autres réductions.' },
        { p: '**Attention :** si vous possédez déjà une formation incluse dans un pack, cette formation n’est ni remboursée ni remplacée. Un avertissement est affiché avant le paiement. Si vous le souhaitez, vous pouvez acheter uniquement les formations qui vous manquent, à l’unité.' },
      ],
    },
    {
      id: 'article-4',
      title: 'Article 4 — Commander et payer',
      blocks: [
        { ol: [
          'Vous créez votre compte et vous choisissez une formation ou un pack.',
          'Vous cochez la case d’acceptation des CGU et des CGV, la case de demande d’accès immédiat (article 7.1) et la case de certification d’âge (article 9).',
          'Vous payez en ligne via notre prestataire de paiement PayTech, avec les moyens affichés au moment du paiement (Wave, Orange Money ou carte bancaire).',
          'Votre commande est confirmée dès la validation du paiement. Vous recevez une confirmation par e-mail et l’accès à votre formation est activé automatiquement.',
        ] },
        { p: `XP ne conserve pas vos données de carte ou de compte de paiement : elles sont traitées par le prestataire de paiement. Le paiement est exigible en totalité au moment de la commande. XP n’ajoute aucun frais au prix affiché. Vous pouvez demander une facture ou un reçu à ${CONTACT_EMAIL}.` },
      ],
    },
    {
      id: 'article-5',
      title: 'Article 5 — Accès et durée',
      blocks: [
        { p: '**En bref :** *6 mois par formation payante, à partir de la validation du paiement. Après, vous gardez votre historique et votre certificat, mais plus l’accès aux leçons.*' },
        { ul: [
          'La durée d’accès est de **six (6) mois calendaires** pour chaque formation payante, à compter de la validation du paiement.',
          'Pour un pack, toutes les formations du pack sont activées en même temps, le jour de la validation du paiement, et expirent ensemble.',
          'À l’expiration, les leçons, exercices et contenus payants ne sont plus accessibles. Votre historique est conservé.',
          'Un certificat déjà obtenu reste valide et vérifiable. Les fichiers déjà téléchargés restent utilisables pour votre travail personnel.',
          'La formation gratuite (C1-F4) est accessible pour une durée indéterminée. XP peut la faire évoluer ou la retirer, en informant les apprenants.',
        ] },
        { p: 'L’accès est personnel (voir CGU, article 4). Pour les commandes d’entreprise, voir l’article 10.' },
      ],
    },
    {
      id: 'article-6',
      title: 'Article 6 — Ce qu’il vous faut pour suivre une formation',
      blocks: [
        { ul: [
          'Un ordinateur, une tablette ou un smartphone récent, avec un navigateur à jour.',
          'Une connexion internet stable. Les vidéos sont diffusées en ligne : il n’y a pas de téléchargement des vidéos.',
          'Pour l’entraînement vocal : un micro, un casque ou des haut-parleurs, et l’autorisation d’accès au micro dans votre navigateur.',
        ] },
      ],
    },
    {
      id: 'article-7',
      title: 'Article 7 — Rétractation et remboursement',
      blocks: [
        { p: '*En bref : Les présentes conditions précisent vos droits en matière de rétractation, les solutions proposées en cas de problème lié à la fourniture du service et les modalités de traitement des demandes de remboursement.*' },
        { h3: '7.1 Demander un accès immédiat' },
        { p: 'Les formations XP Client Academy sont accessibles en ligne après confirmation du paiement.' },
        { p: 'Lors de la commande, le Client demande expressément l’activation immédiate de son accès à la formation, avant l’expiration éventuelle du délai légal de rétractation.' },
        { p: 'Cette demande ne prive pas le Client des droits qui lui sont reconnus par la législation sénégalaise.' },
        { h3: '7.2 Droit de rétractation (consommateurs)' },
        { p: 'Le Client agissant en qualité de consommateur bénéficie du droit de rétractation prévu par la réglementation sénégalaise relative aux contrats conclus à distance, sous réserve des exceptions légalement applicables.' },
        { p: `Pour exercer ce droit, le Client peut adresser sa demande à ${CONTACT_EMAIL}, en précisant son identité et la référence de sa commande.` },
        { p: 'Les demandes sont examinées conformément aux dispositions légales applicables, notamment concernant les délais, les éventuelles exceptions et les modalités de remboursement.' },
        { h3: '7.3 — Problèmes liés à la fourniture du service' },
        { p: 'En cas de paiement confirmé sans activation de l’accès, de double paiement, d’erreur de facturation ou d’indisponibilité prolongée d’une fonctionnalité essentielle annoncée, le Client peut contacter XP Client Academy.' },
        { p: 'Après vérification, XP Client Academy propose une solution adaptée à la situation : correction de l’anomalie, rétablissement du service, prolongation de l’accès ou remboursement total ou partiel, sans préjudice des droits légaux du Client.' },
        { h3: '7.4 Modalités de traitement des remboursements' },
        { p: `Les demandes de remboursement sont adressées à ${CONTACT_EMAIL}.` },
        { p: 'Après vérification de la commande et des conditions applicables, XP Client Academy informe le Client des suites données à sa demande.' },
        { p: 'Lorsqu’un remboursement est dû, il est effectué selon les modalités et dans les délais prévus par la réglementation applicable, en tenant compte des moyens de paiement utilisés.' },
        { h3: '7.5 Achats professionnels' },
        { p: 'Les dispositions relatives au droit de rétractation des consommateurs s’appliquent dans les conditions prévues par la réglementation en vigueur. Les commandes professionnelles restent soumises aux conditions contractuelles convenues et aux dispositions légales qui leur sont applicables.' },
      ],
    },
    {
      id: 'article-8',
      title: 'Article 8 — Entraînement vocal',
      blocks: [
        { p: 'L’entraînement vocal de la formation C1-F2 n’est pas encore ouvert. Le nombre d’essais inclus et ses conditions seront publiés dans une nouvelle version des présentes conditions avant son ouverture. Ils ne réduiront rien de ce qui a déjà été acheté.' },
      ],
    },
    {
      id: 'article-9',
      title: 'Article 9 — Mineurs',
      blocks: [
        { p: 'L’achat est réservé aux personnes majeures. Un mineur peut suivre une formation avec l’autorisation de son parent ou représentant légal. Dans ce cas, l’achat est fait par le parent ou le représentant légal, qui accepte les présentes CGV, assume la commande et autorise l’utilisation de la plateforme par le mineur. Au moment de l’achat, vous certifiez avoir 18 ans ou plus, ou acheter en tant que parent ou tuteur. XP peut demander une confirmation de cette autorisation.' },
      ],
    },
    {
      id: 'article-10',
      title: 'Article 10 — Licences d’équipe (entreprises)',
      blocks: [
        { p: '**En bref :** *Une entreprise commande, paie 100 % avant l’activation, puis attribue les licences à ses collaborateurs pendant 6 mois.*' },
        { p: 'Les licences d’équipe permettent à une entreprise de donner accès à des formations existantes à plusieurs de ses collaborateurs. Elles ne comprennent ni atelier, ni coaching, ni diagnostic, ni reporting sur mesure.' },
        { h3: '10.1 Commande et paiement' },
        { ul: [
          'La commande se fait sur devis. Le devis est **valable 30 jours**. Il indique l’entreprise, le contact responsable, les formations, les quantités et le prix.',
          'Le paiement est exigé à **100 % avant toute activation d’accès**, par lien de paiement sécurisé (carte bancaire ou mobile money) via notre prestataire. Une commande impayée n’ouvre aucun accès. Si le paiement n’est pas reçu avant la fin de validité du devis, la commande est annulée. D’autres moyens de paiement pourront être proposés plus tard.',
        ] },
        { h3: '10.2 Remises de volume' },
        { p: 'La remise dépend du nombre de **personnes distinctes** dans une même commande, et non du nombre de formations. Exemple : 10 collaborateurs inscrits chacun à deux formations comptent pour 10 personnes (remise de 10 %).' },
        { table: {
          head: ['Personnes distinctes dans la commande', 'Remise'],
          rows: [
            ['1 à 4', '0 %'],
            ['5 à 9', '5 %'],
            ['10 à 19', '10 %'],
            ['20 à 49', '15 %'],
            ['50 et plus', 'Sur devis'],
          ],
        } },
        { p: 'Ces pourcentages sont provisoires et peuvent évoluer pour les commandes futures. **Règle du tarif le plus avantageux :** pour une commande d’entreprise, XP applique le tarif le plus avantageux pour le Client entre le prix du pack correspondant et le prix des formations à l’unité avec remise de volume. Les réductions ne sont pas cumulables. Pour une commande qui mélange packs et formations à l’unité, XP calcule le tarif le plus avantageux au cas par cas et l’indique dans le devis.' },
        { h3: '10.3 Attribution, transfert et expiration' },
        { ul: [
          'Le Client attribue les licences à des collaborateurs distincts pendant **six (6) mois calendaires** à compter de la commande. Les licences non attribuées à l’échéance expirent, sans prolongation automatique.',
          'Chaque accès attribué suit la durée de 6 mois prévue à l’article 5, à compter de son attribution.',
          'Une licence attribuée peut être transférée à un autre collaborateur **uniquement si la formation n’a jamais été ouverte**. Le transfert ne prolonge ni le délai d’attribution de la commande ni un accès déjà démarré.',
          'Dès que la formation est ouverte, la licence devient nominative et ne peut plus être transférée. La progression et le certificat ne se transfèrent pas.',
        ] },
        { h3: '10.4 Suivi par l’entreprise' },
        { p: 'Le responsable désigné par l’entreprise voit, pour les collaborateurs rattachés à sa propre entreprise : les inscrits et formations attribuées, l’avancement, les formations terminées et les certificats obtenus, sous la forme d’un tableau de bord ou d’un export sécurisé fourni par XP. Il ne voit jamais les données d’une autre entreprise. Le Client informe ses collaborateurs de ce suivi.' },
      ],
    },
    {
      id: 'article-11',
      title: 'Article 11 — Facturation',
      blocks: [
        { p: 'XP émet une facture ou un reçu pour chaque vente, avec ses références légales (RCCM, NINEA). Pour une entreprise, merci de fournir sa raison sociale, son adresse et son NINEA.' },
      ],
    },
    {
      id: 'article-12',
      title: 'Article 12 — Garanties et responsabilité',
      blocks: [
        { p: 'XP s’engage à fournir les formations décrites. XP ne garantit aucun résultat professionnel ou chiffré (voir CGU, article 9). La responsabilité de XP est limitée dans les conditions prévues aux CGU. Aucune partie n’est responsable d’un retard ou d’une impossibilité d’exécuter causé par un événement de force majeure.' },
      ],
    },
    {
      id: 'article-13',
      title: 'Article 13 — Service client et réclamations',
      blocks: [
        { p: `Pour toute question ou réclamation, écrivez à ${CONTACT_EMAIL} ou contactez-nous sur WhatsApp au ${CONTACT_PHONE}. Nous répondons sous **48 heures ouvrées**.` },
      ],
    },
    {
      id: 'article-14',
      title: 'Article 14 — Données personnelles',
      blocks: [
        { p: 'Le traitement des données est décrit à l’article 10 des CGU et dans notre politique de confidentialité. Pour une commande d’entreprise, le Client garantit qu’il est en droit de transmettre les données de ses collaborateurs.' },
      ],
    },
    {
      id: 'article-15',
      title: 'Article 15 — Droit applicable et litiges',
      blocks: [
        { p: 'Les CGV sont soumises au droit sénégalais. En cas de litige, les parties cherchent d’abord une solution amiable. À défaut, les tribunaux compétents de Dakar sont saisis, sous réserve des règles qui protègent le consommateur.' },
      ],
    },
  ],
}

// ── Politique de confidentialité ────────────────────────────────────────────

export const PRIVACY: LegalText = {
  title: 'Politique de confidentialité',
  version: '1.0',
  dated: 'novembre 2026',
  intro: [
    { p: '**En bref :** *Nous collectons le minimum de données pour vous donner accès à vos formations, vous délivrer vos certificats et vous aider en cas de problème. Nous ne vendons pas vos données. Vous pouvez à tout moment demander à les consulter, les corriger ou les supprimer.*' },
  ],
  sections: [
    {
      id: 'responsable',
      title: '1. Qui est responsable de vos données',
      blocks: [
        { p: `**XP CLIENT**, société unipersonnelle à responsabilité limitée (SUARL), éditrice de la plateforme XP Client Academy. Siège : Ngor Cité SOCABEG, villa n° 16, Dakar, Sénégal. Contact pour toute question sur vos données : ${CONTACT_EMAIL}.` },
        { p: 'Cette politique respecte la loi sénégalaise n° 2008-12 du 25 janvier 2008 sur la protection des données à caractère personnel.' },
      ],
    },
    {
      id: 'donnees',
      title: '2. Les données que nous collectons, pourquoi et pour combien de temps',
      blocks: [
        { table: {
          head: ['Données', 'À quoi elles servent', 'Durée de conservation'],
          rows: [
            ['Nom, prénom, e-mail, téléphone', 'Créer et gérer votre compte, vous contacter, assurer le support', 'Pendant la vie de votre compte'],
            ['Entreprise, fonction (si vous venez d’une entreprise)', 'Gérer les licences d’équipe et le suivi demandé par votre employeur', 'Pendant la vie de votre compte'],
            ['Identifiants de connexion', 'Sécuriser votre accès', 'Pendant la vie de votre compte'],
            ['Progression, résultats aux quiz, certificats', 'Suivre votre formation, délivrer et vérifier vos certificats', 'Tant que le certificat doit pouvoir être vérifié'],
            ['Commande : référence, montant, date, formation', 'Traiter votre achat, émettre la facture, gérer les remboursements', 'Durée légale de conservation des pièces comptables'],
            ['Preuve d’acceptation des CGU et des CGV : date, version, informations techniques de traçabilité', 'Prouver ce que vous avez accepté', 'Tant que nécessaire pour prouver l’acceptation'],
            ['Échanges avec le support (e-mail, WhatsApp)', 'Répondre à vos demandes et régler les réclamations', 'Le temps nécessaire au traitement de la demande'],
            ['Transcription et évaluation de l’entraînement vocal (C1-F2)', 'Simuler le client et vous donner un retour', 'Voir l’article 6'],
            ['Données techniques (appareil, navigateur, date de connexion)', 'Faire fonctionner le site et le protéger', 'Le temps nécessaire au fonctionnement et à la sécurité du site'],
          ],
        } },
        { p: '**Nous ne conservons pas vos données de carte bancaire ni de compte de paiement.** Elles sont traitées directement par notre prestataire de paiement.' },
      ],
    },
    {
      id: 'base',
      title: '3. Sur quelle base nous utilisons vos données',
      blocks: [
        { ul: [
          '**Pour exécuter votre commande et votre formation :** compte, accès, certificat, facture, support.',
          '**Pour respecter la loi :** conservation des factures et des documents comptables.',
          '**Avec votre accord :** par exemple l’entraînement vocal, lorsqu’il sera ouvert, et, le cas échéant, l’envoi d’informations commerciales. Vous pouvez retirer votre accord à tout moment.',
        ] },
      ],
    },
    {
      id: 'destinataires',
      title: '4. Qui reçoit vos données',
      blocks: [
        { p: 'Nous ne vendons pas vos données. Elles sont partagées uniquement avec les prestataires dont nous avons besoin pour faire fonctionner la plateforme :' },
        { table: {
          head: ['Prestataire', 'Rôle'],
          rows: [
            ['Vercel', 'Hébergement du site'],
            ['Supabase', 'Comptes, authentification, base de données (progression, résultats) et stockage protégé des vidéos, documents et fichiers pédagogiques'],
            ['Resend', 'Envoi des e-mails de confirmation et de support'],
            ['PayTech', 'Paiement en ligne (Wave, Orange Money, carte)'],
            ['ElevenLabs', 'Conversation vocale de l’entraînement vocal'],
            ['Anthropic', 'Aide à l’évaluation de certains exercices, selon les formations'],
          ],
        } },
        { p: '**Votre employeur.** Si votre accès est fourni par votre entreprise, elle voit votre progression, vos résultats et vos certificats pour les formations qu’elle vous a attribuées. Elle doit vous en informer. Elle ne voit jamais les données d’une autre entreprise.' },
        { p: '**Autorités.** Nous pouvons communiquer des données si la loi ou une décision de justice nous y oblige.' },
      ],
    },
    {
      id: 'transferts',
      title: '5. Données envoyées hors du Sénégal',
      blocks: [
        { p: 'Nos prestataires sont des services internationaux. Vos données peuvent donc être stockées ou traitées hors du Sénégal, notamment pour l’hébergement, l’envoi d’e-mails et les fonctions d’intelligence artificielle. Nous choisissons des prestataires reconnus et nous limitons ce qui leur est transmis au strict nécessaire.' },
      ],
    },
    {
      id: 'entrainement-vocal',
      title: '6. L’entraînement vocal',
      blocks: [
        { p: `L’entraînement vocal de la formation C1-F2 n’est pas encore ouvert. Lorsqu’il le sera, votre micro captera votre voix pendant l’exercice. Elle sera traitée par notre prestataire de conversation vocale (ElevenLabs) pour simuler le client et vous donner un retour, et la plateforme pourra enregistrer la transcription de l’échange et l’évaluation de votre entraînement, que vous retrouverez dans votre espace. Vous ne pourrez utiliser l’entraînement qu’après avoir accepté ce traitement, et vous pourrez demander la suppression de ces données en écrivant à ${CONTACT_EMAIL}.` },
      ],
    },
    {
      id: 'mineurs',
      title: '7. Les mineurs',
      blocks: [
        { p: 'L’achat est réservé aux personnes majeures. Un mineur peut suivre une formation avec l’autorisation de son parent ou représentant légal, qui effectue l’achat. Nous limitons les données collectées au strict nécessaire.' },
      ],
    },
    {
      id: 'droits',
      title: '8. Vos droits',
      blocks: [
        { p: 'Vous pouvez à tout moment :' },
        { ul: [
          'demander **l’accès** à vos données ;',
          'demander leur **correction** si elles sont inexactes ;',
          'demander leur **suppression**, dans les limites des obligations légales de conservation (par exemple les factures) ;',
          'vous **opposer** à certains usages, notamment l’envoi d’informations commerciales ;',
          '**retirer votre accord** quand le traitement repose sur votre accord.',
        ] },
        { p: `Écrivez à ${CONTACT_EMAIL} en indiquant votre nom et l’e-mail de votre compte. Nous vérifions votre identité pour protéger vos données, traitons votre demande et répondons dans un délai de 30 jours. Si vous estimez que vos droits ne sont pas respectés, vous pouvez saisir la **Commission de protection des données personnelles (CDP)** du Sénégal.` },
      ],
    },
    {
      id: 'securite',
      title: '9. Comment nous protégeons vos données',
      blocks: [
        { p: 'Connexion sécurisée (HTTPS), mots de passe gérés par un service d’authentification sécurisé, fichiers pédagogiques à accès protégé, et accès limité : chaque apprenant ne voit que ses propres données, et seules les personnes autorisées de l’administration peuvent les gérer. Aucun système n’est parfaitement sûr : en cas d’incident grave touchant vos données, nous vous en informons.' },
      ],
    },
    {
      id: 'cookies',
      title: '10. Cookies et traceurs',
      blocks: [
        { p: 'La plateforme utilise des mécanismes de session **indispensables** à son fonctionnement (connexion, sécurité). Si nous ajoutons un jour un outil de mesure d’audience ou de publicité, nous vous le dirons et nous vous demanderons votre accord avant de l’activer.' },
      ],
    },
    {
      id: 'modifications',
      title: '11. Modifications de cette politique',
      blocks: [
        { p: 'Nous pouvons mettre à jour cette politique. Le numéro de version et la date figurent en haut de la page, et nous vous informons des changements importants.' },
      ],
    },
    {
      id: 'contact',
      title: '12. Nous contacter',
      blocks: [
        { p: `${CONTACT_EMAIL} — WhatsApp : ${CONTACT_PHONE}. Nous répondons sous 48 heures ouvrées.` },
      ],
    },
  ],
}

// ── Mentions légales ────────────────────────────────────────────────────────

export const LEGAL_NOTICE: LegalText = {
  title: 'Mentions légales',
  version: '1.0',
  dated: 'novembre 2026',
  intro: [],
  sections: [
    {
      id: 'editeur',
      title: 'Éditeur de la plateforme',
      blocks: [
        { p: 'La plateforme XP Client Academy est éditée par **XP CLIENT**, société unipersonnelle à responsabilité limitée (SUARL) de droit sénégalais.' },
        { ul: [
          'Nom commercial : XP Client Consulting',
          'Capital social : 150 000 FCFA',
          'Siège social : Ngor Cité SOCABEG, villa n° 16, Dakar, Sénégal',
          'RCCM : SN.DKR.2026.B.38780',
          'NINEA : 013427788',
          'Gérante : Marième BA',
          'Directrice de la publication : Marième BA',
        ] },
      ],
    },
    {
      id: 'contact',
      title: 'Contact',
      blocks: [
        { ul: [
          `E-mail : ${CONTACT_EMAIL}`,
          `WhatsApp : ${CONTACT_PHONE}`,
        ] },
        { p: 'Nous répondons sous 48 heures ouvrées.' },
      ],
    },
    {
      id: 'hebergement',
      title: 'Hébergement',
      blocks: [
        { p: 'Le site est hébergé par **Vercel Inc.** (États-Unis). Les comptes, les données de progression et les fichiers pédagogiques sont stockés par **Supabase**. La liste complète de nos prestataires figure dans la politique de confidentialité.' },
      ],
    },
    {
      id: 'propriete-intellectuelle',
      title: 'Propriété intellectuelle',
      blocks: [
        { p: 'Les formations, vidéos, textes, quiz, exercices, documents, images, voix et les noms XP Client Academy et XP Client Consulting appartiennent à XP CLIENT ou sont utilisés avec autorisation. Toute reproduction, diffusion ou revente sans autorisation écrite est interdite. Les droits d’usage accordés aux apprenants sont décrits dans les Conditions générales d’utilisation.' },
      ],
    },
    {
      id: 'donnees-personnelles',
      title: 'Données personnelles',
      blocks: [
        { p: `XP CLIENT traite des données personnelles pour gérer les comptes, donner accès aux formations et délivrer les certificats, conformément à la loi n° 2008-12 du 25 janvier 2008. Pour en savoir plus et exercer vos droits (accès, rectification, suppression), consultez notre politique de confidentialité ou écrivez à ${CONTACT_EMAIL}.` },
      ],
    },
    {
      id: 'conditions',
      title: 'Conditions applicables',
      blocks: [
        { p: 'L’utilisation de la plateforme est soumise aux Conditions générales d’utilisation, et tout achat aux Conditions générales de vente. Ces documents, ainsi que la politique de confidentialité, sont accessibles en pied de page du site.' },
      ],
    },
    {
      id: 'reclamations',
      title: 'Réclamations',
      blocks: [
        { p: `Pour toute réclamation, écrivez à ${CONTACT_EMAIL} en indiquant votre nom et, le cas échéant, le numéro de votre commande. Nous cherchons d’abord une solution amiable.` },
      ],
    },
    {
      id: 'droit-applicable',
      title: 'Droit applicable',
      blocks: [
        { p: 'Les présentes mentions sont soumises au droit sénégalais.' },
      ],
    },
  ],
}

/** Every block's text, flattened, for checks that read the published wording. */
export function legalTextPlain(doc: LegalText): string {
  const parts: string[] = [doc.title]
  const walk = (blocks: readonly LegalBlock[]) => {
    for (const b of blocks) {
      if ('p' in b) parts.push(b.p)
      else if ('h3' in b) parts.push(b.h3)
      else if ('ul' in b) parts.push(...b.ul)
      else if ('ol' in b) parts.push(...b.ol)
      else parts.push(...b.table.head, ...b.table.rows.flat())
    }
  }
  walk(doc.intro)
  for (const s of doc.sections) { parts.push(s.title); walk(s.blocks) }
  return parts.join('\n')
}
