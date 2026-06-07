/**
 * XP Client Academy Platform — Seed Data
 * Flagship course: "Understand the Customer to Deliver a Quality Experience"
 *
 * Use this to populate the database via Supabase dashboard or a seed script.
 */

import type { Course, Module, Lesson, Quiz, QuizQuestion } from '@/types'

// ── Flagship Course ───────────────────────────────────────────────────────────

export const FLAGSHIP_COURSE: Omit<Course, 'id' | 'created_at' | 'updated_at'> = {
  slug:            'comprendre-client-qualite-experience',
  title:           'Comprendre le Client pour Délivrer une Expérience de Qualité',
  title_fr:        'Comprendre le Client pour Délivrer une Expérience de Qualité',
  description:
    'Une formation complète et pratique pour maîtriser les fondamentaux de l\'expérience client. ' +
    'Apprenez à comprendre vos clients, à cartographier leur parcours, et à créer des interactions mémorables ' +
    'qui fidélisent et différencient votre entreprise.',
  description_fr: null,
  cover_url:      null,
  // TEMP_FREE_ACCESS: price set to 0 and is_free set to true for pilot phase.
  // To restore: set price back to 45000 and is_free back to false.
  price:          0,
  currency:       'XOF',
  is_published:   true,
  is_free:        true,
  level:          'beginner',
  duration_hours: 8,
  language:       'fr',
}

// ── Modules & Lessons ─────────────────────────────────────────────────────────
// Structure mirrors the real video content in /public/videos/.
// Module order matches the video production numbering (Modules 1–4 have videos;
// Module 5 is text-only content reserved for future recordings).

export const COURSE_MODULES = [
  // ── Module 1 ──────────────────────────────────────────────────────────────
  {
    slug:        'introduction-experience-client',
    title:       'Comprendre l\'Expérience Client',
    order_index: 1,
    description:
      'Posez les bases : qu\'est-ce que l\'expérience client, pourquoi est-ce un enjeu stratégique, ' +
      'et comment les attentes clients ont-elles évolué ?',
    lessons: [
      {
        slug:             'quest-ce-que-la-cx',
        title:            'Comprendre l\'Expérience Client',
        order_index:      1,
        duration_minutes: 18,
        is_preview:       true,
        // video: public/videos/module-1-comprendre-experience-client.mp4
        video_url: '/videos/module-1-comprendre-experience-client.mp4',
        content: `
## Définition de l'Expérience Client

L'expérience client (CX) désigne la **perception globale** qu'un client développe à travers toutes ses interactions avec une entreprise — avant, pendant et après l'achat.

### Pourquoi c'est important ?
- 86 % des clients sont prêts à payer plus pour une meilleure expérience
- Une expérience positive génère de la fidélité et du bouche-à-oreille
- L'expérience client est devenu le principal différenciateur concurrentiel

### Les 3 dimensions de la CX
1. **Cognitive** — ce que le client pense de vous
2. **Émotionnelle** — ce qu'il ressent lors de l'interaction
3. **Comportementale** — ce qu'il fait ensuite (revient-il ? vous recommande-t-il ?)
        `,
      },
      {
        slug:             'pourquoi-cx-compte',
        title:            'Pourquoi la CX est un Avantage Compétitif',
        order_index:      2,
        duration_minutes: 15,
        is_preview:       false,
        video_url:        null,
        content: `
## L'impact business de la CX

Des études montrent que les entreprises leaders en CX surpassent leurs concurrents de **4 à 8 %** en termes de revenus.

### Chiffres clés
- Acquérir un nouveau client coûte **5 à 7 fois** plus cher que de fidéliser un client existant
- Une augmentation de 5 % de la fidélisation peut augmenter les profits de **25 à 95 %**
- Les clients qui vivent une excellente expérience dépensent en moyenne **140 % de plus**
        `,
      },
      {
        slug:             'evolution-attentes-clients',
        title:            "L'Évolution des Attentes Clients à l'Ère Digitale",
        order_index:      3,
        duration_minutes: 12,
        is_preview:       false,
        video_url:        null,
        content:          'Contenu de leçon — à compléter.',
      },
    ],
    quiz: {
      title: 'Quiz — Module 1 : Comprendre la CX',
      questions: [
        {
          question:       "Quelle est la définition la plus complète de l'expérience client ?",
          options:        [
            "La qualité du service après-vente",
            "La perception globale d'un client à travers toutes ses interactions avec l'entreprise",
            "Le niveau de satisfaction mesuré par questionnaire",
            "L'ergonomie d'un site web ou d'une application",
          ],
          correct_answer: 1,
          explanation:    "L'expérience client englobe toutes les interactions, pas seulement le service après-vente ou un point de contact spécifique.",
          order_index:    1,
        },
        {
          question:       "De combien coûte l'acquisition d'un nouveau client par rapport à la fidélisation ?",
          options:        ["2 fois plus cher", "5 à 7 fois plus cher", "10 fois plus cher", "Le même prix"],
          correct_answer: 1,
          explanation:    "Les études montrent qu'acquérir un nouveau client coûte entre 5 et 7 fois plus cher que de fidéliser un client existant.",
          order_index:    2,
        },
        {
          question:       "Quelles sont les 3 dimensions de l'expérience client ?",
          options:        [
            "Visuelle, auditive, olfactive",
            "Avant-vente, vente, après-vente",
            "Cognitive, émotionnelle, comportementale",
            "Produit, prix, promotion",
          ],
          correct_answer: 2,
          explanation:    "Les 3 dimensions sont : cognitive (ce que le client pense), émotionnelle (ce qu'il ressent), comportementale (ce qu'il fait).",
          order_index:    3,
        },
      ],
    },
  },

  // ── Module 2 ──────────────────────────────────────────────────────────────
  {
    slug:        'parcours-client-moments-verite',
    title:       'Comprendre le Parcours Client',
    order_index: 2,
    description:
      'Apprenez à visualiser et analyser le parcours client, identifier les points de contact critiques ' +
      'et transformer les moments de vérité en opportunités de différenciation.',
    lessons: [
      {
        slug:             'cartographie-parcours-client',
        title:            'Comprendre le Parcours Client',
        order_index:      1,
        duration_minutes: 22,
        is_preview:       false,
        // video: public/videos/module-2-comprendre-parcours-client.mp4
        video_url: '/videos/module-2-comprendre-parcours-client.mp4',
        content:   'Contenu de leçon — à compléter.',
      },
      {
        slug:             'points-de-contact-canaux',
        title:            'Points de Contact & Canaux d\'Interaction',
        order_index:      2,
        duration_minutes: 18,
        is_preview:       false,
        video_url:        null,
        content:          'Contenu de leçon — à compléter.',
      },
      {
        slug:             'moments-de-verite',
        title:            'Les Moments de Vérité — Le Concept de Jan Carlzon',
        order_index:      3,
        duration_minutes: 16,
        is_preview:       false,
        video_url:        null,
        content:          'Contenu de leçon — à compléter.',
      },
      {
        slug:             'points-douleur-opportunites',
        title:            'Identifier les Points de Douleur et les Opportunités',
        order_index:      4,
        duration_minutes: 20,
        is_preview:       false,
        video_url:        null,
        content:          'Contenu de leçon — à compléter.',
      },
    ],
    quiz: {
      title: 'Quiz — Module 2 : Parcours Client',
      questions: [
        {
          question:       "Qu'est-ce qu'un moment de vérité selon Jan Carlzon ?",
          options:        [
            "Le moment où un client décide d'acheter",
            "Tout instant où un client interagit avec l'entreprise et se forme une opinion",
            "La satisfaction finale après l'achat",
            "Le résultat d'une enquête de satisfaction",
          ],
          correct_answer: 1,
          explanation:    "Jan Carlzon définissait les moments de vérité comme chaque instant de contact entre le client et l'entreprise qui influence sa perception.",
          order_index:    1,
        },
      ],
    },
  },

  // ── Module 3 ──────────────────────────────────────────────────────────────
  // NOTE: In the video production order "Module 3" covers emotions (not fondamentaux).
  // The DB was updated in migration 006 to move comprendre-emotions-clients to order 3.
  {
    slug:        'comprendre-emotions-clients',
    title:       'Comprendre les Émotions des Clients',
    order_index: 3,
    description:
      'Explorez la dimension émotionnelle de l\'expérience client et apprenez à créer des connexions ' +
      'authentiques qui transforment les clients en ambassadeurs fidèles.',
    lessons: [
      {
        slug:             'dimension-emotionnelle-cx',
        title:            'Comprendre les Émotions des Clients',
        order_index:      1,
        duration_minutes: 16,
        is_preview:       false,
        // video: public/videos/module-3-comprendre-emotions-clients.mp4
        video_url: '/videos/module-3-comprendre-emotions-clients.mp4',
        content:   'Contenu de leçon — à compléter.',
      },
      {
        slug:             'cartographie-emotions',
        title:            'Cartographie des Émotions Clients',
        order_index:      2,
        duration_minutes: 18,
        is_preview:       false,
        video_url:        null,
        content:          'Contenu de leçon — à compléter.',
      },
      {
        slug:             'connexions-emotionnelles',
        title:            'Créer des Connexions Émotionnelles Durables',
        order_index:      3,
        duration_minutes: 20,
        is_preview:       false,
        video_url:        null,
        content:          'Contenu de leçon — à compléter.',
      },
    ],
    quiz: {
      title: 'Quiz — Module 3 : Émotions Clients',
      questions: [
        {
          question:       "Quel impact ont les émotions positives sur le comportement d'achat ?",
          options:        ["Aucun impact mesurable", "Les clients dépensent davantage et recommandent l'entreprise", "Les clients sont plus exigeants", "Cela dépend uniquement du prix"],
          correct_answer: 1,
          explanation:    "Les émotions positives créent un lien de confiance qui augmente la valeur à vie du client et génère du bouche-à-oreille.",
          order_index:    1,
        },
      ],
    },
  },

  // ── Module 4 ──────────────────────────────────────────────────────────────
  // Two-lesson module — both lessons have real video files.
  {
    slug:        'creer-experience-client-qualite',
    title:       'Créer une Expérience Client de Qualité',
    order_index: 4,
    description:
      'Maîtrisez les techniques pour créer des interactions mémorables et gérer toutes les situations ' +
      'clients avec professionnalisme et efficacité.',
    lessons: [
      {
        slug:             'creer-interaction-qualite',
        title:            'Créer une Interaction de Qualité',
        order_index:      1,
        duration_minutes: 20,
        is_preview:       false,
        // video: public/videos/module-4-lecon-1-creer-interaction-qualite.mp4
        video_url: '/videos/module-4-lecon-1-creer-interaction-qualite.mp4',
        content: `
## Créer une Interaction de Qualité

Une interaction de qualité repose sur trois piliers essentiels : la **préparation**, la **présence** et la **personnalisation**.

### Les clés d'une interaction réussie
- Accueillez chaque client comme s'il était votre seul client
- Adaptez votre ton et votre langage au profil de votre interlocuteur
- Anticipez les besoins avant qu'ils ne soient exprimés

### La règle des 7 secondes
Les premières impressions se forment en 7 secondes. Chaque interaction commence bien avant que le client prenne la parole.
        `,
      },
      {
        slug:             'gerer-situations-clients',
        title:            'Gérer les Situations Clients',
        order_index:      2,
        duration_minutes: 18,
        is_preview:       false,
        // video: public/videos/module-4-lecon-2-gerer-situations-clients.mp4
        video_url: '/videos/module-4-lecon-2-gerer-situations-clients.mp4',
        content: `
## Gérer les Situations Clients

Savoir gérer des situations clients difficiles est une compétence clé qui distingue les équipes ordinaires des équipes d'excellence.

### Les 4 étapes LEAD
1. **Listen** — Écoutez sans interrompre
2. **Empathize** — Validez les émotions du client
3. **Apologize** — Présentez des excuses sincères si nécessaire
4. **Deliver** — Proposez une solution concrète et tenez votre engagement

### Les erreurs à éviter
- Être défensif ou justifier l'erreur de l'entreprise
- Promettre ce qu'on ne peut pas tenir
- Transférer le client d'un agent à l'autre sans solution
        `,
      },
    ],
    quiz: {
      title: 'Quiz — Module 4 : Créer une Expérience de Qualité',
      questions: [
        {
          question:       "Quelles sont les 4 étapes de la méthode LEAD pour gérer les situations clients ?",
          options:        [
            "Look, Engage, Act, Deliver",
            "Listen, Empathize, Apologize, Deliver",
            "Learn, Evaluate, Adapt, Deploy",
            "Listen, Explain, Agree, Done",
          ],
          correct_answer: 1,
          explanation:    "La méthode LEAD : Listen (écouter), Empathize (comprendre), Apologize (s'excuser si nécessaire), Deliver (apporter une solution).",
          order_index:    1,
        },
        {
          question:       "En combien de secondes se forment les premières impressions lors d'une interaction ?",
          options:        ["1 seconde", "7 secondes", "30 secondes", "1 minute"],
          correct_answer: 1,
          explanation:    "Les recherches montrent que les premières impressions se forment en seulement 7 secondes.",
          order_index:    2,
        },
      ],
    },
  },

  // ── Module 5 ──────────────────────────────────────────────────────────────
  // Text-only module — video content reserved for future recordings.
  {
    slug:        'outils-cx-petites-entreprises',
    title:       'Outils CX Essentiels',
    order_index: 5,
    description:
      'Découvrez les indicateurs clés (NPS, CSAT, CES), des méthodes simples de collecte de feedback ' +
      'et comment construire une culture orientée client dans votre organisation.',
    lessons: [
      {
        slug: 'nps-csat-ces', title: 'NPS, CSAT et CES — Comprendre les Indicateurs',
        order_index: 1, duration_minutes: 20, is_preview: false, video_url: null, content: 'Contenu de leçon — à compléter.',
      },
      {
        slug: 'collecte-feedback', title: 'Méthodes Simples de Collecte de Feedback',
        order_index: 2, duration_minutes: 16, is_preview: false, video_url: null, content: 'Contenu de leçon — à compléter.',
      },
      {
        slug: 'culture-client', title: 'Construire une Culture Orientée Client',
        order_index: 3, duration_minutes: 18, is_preview: false, video_url: null, content: 'Contenu de leçon — à compléter.',
      },
    ],
    quiz: {
      title: 'Quiz Final — Évaluation du Cours',
      questions: [
        {
          question:       "Que mesure le NPS (Net Promoter Score) ?",
          options:        ["La satisfaction immédiate après une interaction", "La probabilité qu'un client recommande l'entreprise", "L'effort fourni par le client pour obtenir de l'aide", "La fréquence d'achat"],
          correct_answer: 1,
          explanation:    "Le NPS mesure la fidélité client en demandant : 'Sur une échelle de 0 à 10, quelle est la probabilité que vous recommandiez notre entreprise ?'",
          order_index:    1,
        },
        {
          question:       "Qu'est-ce que le CES (Customer Effort Score) ?",
          options:        ["Le coût d'acquisition d'un client", "La mesure de l'effort fourni par le client pour résoudre son problème", "Un indicateur de satisfaction globale", "Un score de recommandation"],
          correct_answer: 1,
          explanation:    "Le CES mesure l'effort que le client doit fournir — plus l'effort est faible, meilleure est l'expérience.",
          order_index:    2,
        },
        {
          question:       "Quelle est la première étape pour construire une culture orientée client ?",
          options:        ["Acheter un logiciel CRM", "Obtenir l'engagement de la direction", "Former uniquement l'équipe commerciale", "Réduire les prix"],
          correct_answer: 1,
          explanation:    "Le changement de culture commence toujours par l'engagement visible et sincère de la direction.",
          order_index:    3,
        },
      ],
    },
  },
]

// ── Marketing Copy ────────────────────────────────────────────────────────────

export const COURSE_COPY = {
  enrollment_cta:    'S\'inscrire à cette formation',
  payment_cta:       'Payer et accéder à la formation',
  free_preview_cta:  'Voir la leçon gratuite',
  hero_tagline:      'Formez-vous à l\'expérience client et transformez votre entreprise',
  hero_sub:
    'Des formations en ligne certifiantes pour individus et entreprises. ' +
    'Payez avec Orange Money, Wave ou carte bancaire.',
  stats: {
    companies:   '200+ entreprises',
    improvement: '+35 % satisfaction',
    retention:   '+50 % fidélisation',
    years:       '10 ans d\'expertise',
  },
  testimonials: [
    {
      text:    '"XP Client Academy a transformé la façon dont notre équipe aborde les clients. En 3 mois, notre taux de satisfaction a augmenté de 28 points."',
      author:  'Aminata Mbaye',
      role:    'Directrice Marketing, Telecom Sénégal',
      initials:'AM',
    },
    {
      text:    '"La formation est pratique, bien structurée et directement applicable. Le meilleur investissement formation que j\'ai fait cette année."',
      author:  'Karim Diallo',
      role:    'CEO, Fintech West Africa',
      initials:'KD',
    },
    {
      text:    '"Nos équipes peuvent maintenant mesurer et améliorer l\'expérience client de façon concrète. Je recommande vivement XP Client."',
      author:  'Fatou Fall',
      role:    'DRH, Groupe Bancaire Côte d\'Ivoire',
      initials:'FF',
    },
  ],
}
