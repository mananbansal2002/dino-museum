import { SPECIES, SPECIES_LIST } from "./species.js";

/** Exhibit records derived from the species catalogue. */
export const EXHIBITS = SPECIES_LIST.map((s) => ({
  id: s.id,
  dino: s.id,
  title: s.name,
  tagline: s.info.tagline || "",
  era: s.info.era,
  period: s.info.period,
  habitat: s.info.habitat,
  length: s.info.length,
  weight: s.info.weight,
  diet: s.info.diet,
  speed: s.info.speed,
  teeth: s.info.teeth || "",
  blurb: s.info.blurb,
  facts: s.info.facts,
  stats: s.info.stats,
  battle: s.info.battle || null,
  hall: s.hall,
}));

/* ------------------------------------------------------------------ */
/* BATTLES — the Screening Theatre programme                            */
/* ------------------------------------------------------------------ */
/**
 * Every screening is told on the theatre screen by cinema.js (an image
 * screening built from the fighters' photos; see beats below).
 *
 *  id        stable id (shared over the network, used to key YouTube videos)
 *  a, b      fighter species ids (must exist in SPECIES)
 *  era       short badge text for the picker
 *  kind      "fossil"   – a fossil records this kind of encounter
 *            "coexisted"– the two lived side by side, no direct fight fossil
 *            "whatif"   – they never met; a hypothetical match-up
 *  mood      environment preset in cinema.js
 *  lines     [time, narration] (seconds, ascending)
 *  beats     [time, action, who?] choreography (who: "a" | "b" | "both")
 *            actions: intro approach circle roar charge clash tail retreat
 *                     standoff flee down
 *  videos    [{ id, title, channel }] verified YouTube clips (filled by the lead)
 */
export const BATTLES = [
  {
    id: "trex-vs-trike",
    title: "Tyrannosaurus vs Triceratops",
    subtitle: "Hell Creek Formation · 66 million years ago",
    era: "Late Cretaceous",
    kind: "fossil",
    a: "trex", b: "trike", duration: 26, mood: "sunset",
    lines: [
      [0.5, "HELL CREEK, MONTANA — 66 MILLION YEARS AGO"],
      [3.5, "A Tyrannosaurus rex stalks a lone Triceratops grazing beside a river channel."],
      [7.5, "The Triceratops turns to face it: horns forward, frill up, legs braced."],
      [11.5, "The rex feints. The Triceratops charges, and the tyrant gives ground."],
      [15.5, "The rex circles and bites at the frill as the horns swing past."],
      [19.5, "Wounded but standing, the Triceratops holds its ground. The rex backs off."],
      [23.0, "Healed bite wounds on Triceratops fossils show that some survived attacks like this."],
    ],
    beats: [
      [0, "intro"], [3.5, "approach"], [7.5, "roar", "b"], [9.5, "roar", "a"],
      [11.5, "charge", "b"], [13.2, "retreat", "a"], [15.5, "circle"], [17.0, "charge", "a"],
      [18.3, "clash"], [19.5, "standoff"], [21.0, "retreat", "a"], [23.0, "roar", "b"],
    ],
    facts: [
      "Many Triceratops bones carry T. rex tooth marks, so tyrannosaurs clearly fed on them.",
      "A Triceratops brow horn that was bitten off and then healed shows at least one survived a T. rex attack.",
      "Triceratops and T. rex lived side by side in the last few million years before the asteroid impact.",
    ],
    videos: [],
  },
  {
    id: "allo-vs-stego",
    title: "Allosaurus vs Stegosaurus",
    subtitle: "Morrison Formation · 150 million years ago",
    era: "Late Jurassic",
    kind: "fossil",
    a: "allo", b: "stego", duration: 26, mood: "dusk",
    lines: [
      [0.5, "MORRISON FORMATION, WESTERN USA — 150 MILLION YEARS AGO"],
      [3.5, "A Stegosaurus browses on low ferns, its back plates catching the evening light."],
      [7.5, "An Allosaurus circles, looking for an opening away from that tail."],
      [11.5, "The hunter lunges for the neck. The Stegosaurus swings its spiked tail."],
      [15.5, "A spike drives into the predator's tail. The Allosaurus staggers back."],
      [19.5, "The Stegosaurus turns side-on, keeping its spikes between them."],
      [23.0, "Fossils record both sides of this fight: a punctured Allosaurus bone and a bitten Stegosaurus plate."],
    ],
    beats: [
      [0, "intro"], [3.5, "approach"], [7.5, "circle"], [11.5, "charge", "a"],
      [12.6, "tail", "b"], [15.5, "retreat", "a"], [17.5, "roar", "a"], [19.5, "tail", "b"],
      [21.0, "standoff"], [23.0, "roar", "a"],
    ],
    facts: [
      "An Allosaurus tail vertebra has a hole that matches the size and shape of a Stegosaurus tail spike.",
      "A Stegosaurus neck plate with a U-shaped bite missing matches the jaws of Allosaurus.",
      "Broken and healed tail spikes show that Stegosaurus really used its 'thagomizer' in fights.",
    ],
    videos: [],
  },
  {
    id: "raptor-vs-proto",
    title: "Velociraptor vs Protoceratops",
    subtitle: "Djadokhta Formation · 75 million years ago",
    era: "Late Cretaceous",
    kind: "fossil",
    a: "raptor", b: "proto", duration: 24, mood: "desert",
    lines: [
      [0.5, "DJADOKHTA FORMATION, MONGOLIA — ABOUT 75 MILLION YEARS AGO"],
      [3.0, "On the dunes, a Velociraptor attacks a Protoceratops, a sheep-sized plant-eater."],
      [7.0, "The raptor leaps in, kicking at the throat with its sickle claw."],
      [11.0, "The Protoceratops bites down on the raptor's arm and will not let go."],
      [15.0, "Locked together, neither can win, and neither can escape."],
      [19.0, "Then a dune collapses — or a sandstorm hits — and buries them both mid-fight."],
      [22.0, "Found in 1971, the 'Fighting Dinosaurs' are still locked together today."],
    ],
    beats: [
      [0, "intro"], [3.0, "circle"], [7.0, "charge", "a"], [8.4, "clash"],
      [11.0, "clash"], [15.0, "clash"], [19.0, "down", "both"],
    ],
    facts: [
      "The 'Fighting Dinosaurs' fossil was found in the Gobi Desert in 1971 by a Polish-Mongolian expedition.",
      "The raptor's sickle claw sits in the Protoceratops' neck, while the Protoceratops' beak clamps the raptor's right arm.",
      "The fossil is a national treasure of Mongolia, kept in Ulaanbaatar.",
    ],
    videos: [],
  },
  {
    id: "trex-vs-ankylo",
    title: "Tyrannosaurus vs Ankylosaurus",
    subtitle: "Lance Formation · 67 million years ago",
    era: "Late Cretaceous",
    kind: "coexisted",
    a: "trex", b: "ankylo", duration: 24, mood: "sunset",
    lines: [
      [0.5, "LANCE FORMATION, WYOMING — 67 MILLION YEARS AGO"],
      [3.0, "A Tyrannosaurus rex finds an Ankylosaurus feeding out in the open."],
      [7.0, "The armoured plant-eater crouches low. Bony plates cover its back, neck and head."],
      [11.0, "The rex lunges. The Ankylosaurus swings its heavy tail club at the tyrant's legs."],
      [15.0, "The club connects. A blow like that could crack bone."],
      [19.0, "The rex limps away. An Ankylosaurus was very hard to eat."],
      [22.0, "No fossil shows these two fighting, but they shared the same land."],
    ],
    beats: [
      [0, "intro"], [3.0, "approach"], [7.0, "standoff"], [8.6, "roar", "a"],
      [11.0, "charge", "a"], [12.0, "tail", "b"], [15.0, "tail", "b"], [17.0, "retreat", "a"],
      [19.0, "flee", "a"],
    ],
    facts: [
      "Studies of ankylosaur tail clubs suggest the biggest could swing hard enough to break bone.",
      "Ankylosaurus armour was made of osteoderms: bony plates that grew inside the skin.",
      "Ankylosaurus and T. rex both lived at the very end of the Cretaceous in western North America.",
    ],
    videos: [],
  },
  {
    id: "spino-vs-carchar",
    title: "Spinosaurus vs Carcharodontosaurus",
    subtitle: "Bahariya Formation · 95 million years ago",
    era: "Late Cretaceous",
    kind: "coexisted",
    a: "spino", b: "carchar", duration: 26, mood: "river",
    lines: [
      [0.5, "BAHARIYA, EGYPT — 95 MILLION YEARS AGO"],
      [3.5, "In a mangrove-lined river delta, a Spinosaurus hunts fish in the shallows."],
      [7.5, "A Carcharodontosaurus — the 'shark-toothed lizard' — steps out of the trees."],
      [11.5, "The Spinosaurus turns to face it. Its tall sail makes it look even bigger."],
      [15.5, "The two predators clash at the water's edge."],
      [19.5, "The Spinosaurus backs into deeper water, where the land hunter will not follow."],
      [23.0, "Both lived here: Spinosaurus in and around the rivers, Carcharodontosaurus on land."],
    ],
    beats: [
      [0, "intro"], [7.5, "approach"], [11.5, "roar", "a"], [13.0, "roar", "b"],
      [15.5, "clash"], [17.5, "clash"], [19.5, "retreat", "a"], [23.0, "standoff"],
    ],
    facts: [
      "Ernst Stromer studied fossils of both from Egypt's Bahariya Oasis; most were destroyed in a 1944 bombing raid on Munich.",
      "Spinosaurus had dense bones and a paddle-like tail, suggesting it spent a lot of time in water.",
      "Carcharodontosaurus had blade-like, serrated teeth, which is where its shark name comes from.",
    ],
    videos: [],
  },
  {
    id: "spino-vs-acro",
    title: "Spinosaurus vs Acrocanthosaurus",
    subtitle: "What if? · Africa meets North America",
    era: "Cretaceous",
    kind: "whatif",
    a: "spino", b: "acro", duration: 26, mood: "dusk",
    lines: [
      [0.5, "A WHAT-IF SCREENING — THESE TWO NEVER MET"],
      [3.0, "Acrocanthosaurus lived in North America about 113 million years ago."],
      [7.5, "Spinosaurus lived in North Africa more than 10 million years later."],
      [11.5, "Both had tall spines on their backs: a low ridge on one, a towering sail on the other."],
      [15.5, "On dry land, the heavily built Acrocanthosaurus would probably have the edge."],
      [19.5, "Near water, the long-snouted Spinosaurus would be in its element."],
      [23.0, "Acrocanthosaurus means 'high-spined lizard'."],
    ],
    beats: [
      [0, "intro"], [3.0, "approach"], [7.5, "circle"], [11.5, "roar", "a"],
      [13.0, "roar", "b"], [15.5, "charge", "b"], [16.8, "clash"], [19.5, "retreat", "a"],
      [21.0, "circle"], [23.0, "standoff"],
    ],
    facts: [
      "Acrocanthosaurus fossils come from Oklahoma, Texas and Utah, about 113–110 million years old.",
      "Spinosaurus is known from Egypt and Morocco, about 100–94 million years old.",
      "The two were separated by an ocean as well as by millions of years.",
    ],
    videos: [],
  },
  {
    // id kept for network/video compatibility. Elasmosaurus is a plesiosaur that
    // actually shared the seas with Mosasaurus (Plesiosaurus itself was Early Jurassic).
    id: "mosa-vs-plesio",
    title: "Mosasaurus vs Elasmosaurus",
    subtitle: "Western Interior Seaway · 80 million years ago",
    era: "Late Cretaceous",
    kind: "coexisted",
    a: "mosa", b: "elasmo", duration: 26, mood: "underwater",
    lines: [
      [0.5, "THE WESTERN INTERIOR SEAWAY — 80 MILLION YEARS AGO"],
      [3.0, "An Elasmosaurus, a long-necked plesiosaur, glides through the shallows hunting fish."],
      [7.0, "Below it, a Mosasaurus rises out of the blue, tail beating."],
      [11.0, "The plesiosaur turns away, but with that long neck it is slow to turn."],
      [15.0, "The mosasaur strikes. Jaws and flippers churn the water."],
      [19.0, "Wounded, the Elasmosaurus flees for the open sea."],
      [23.0, "Mosasaurs were the top predators of the Late Cretaceous seas."],
    ],
    beats: [
      [0, "intro"], [3.0, "approach"], [7.0, "circle"], [11.0, "retreat", "b"],
      [15.0, "charge", "a"], [16.2, "clash"], [19.0, "flee", "b"], [23.0, "roar", "a"],
    ],
    facts: [
      "Elasmosaurus had about 72 neck vertebrae, more than any other known animal.",
      "A Tylosaurus, a close cousin of Mosasaurus, was found with plesiosaur bones in its stomach.",
      "Mosasaurs were giant marine lizards, related to today's monitor lizards and snakes.",
    ],
    videos: [],
  },
  {
    id: "baryonyx-vs-iguanodon",
    title: "Baryonyx vs Iguanodon",
    subtitle: "Weald Clay · 125 million years ago",
    era: "Early Cretaceous",
    kind: "fossil",
    a: "baryonyx", b: "iguanodon", duration: 24, mood: "marsh",
    lines: [
      [0.5, "WEALD CLAY, SOUTHERN ENGLAND — 125 MILLION YEARS AGO"],
      [3.0, "A Baryonyx wades through the marsh, its huge thumb claw ready for fish."],
      [7.0, "Nearby, a young Iguanodon stops to drink."],
      [11.0, "The predator's long snout snaps, but the plant-eater is already turning."],
      [15.0, "The Iguanodon jabs with its thumb spike and drives the hunter back."],
      [19.0, "This time it escapes. Not every young Iguanodon did."],
      [22.0, "The first Baryonyx skeleton had fish scales and young iguanodont bones in its stomach."],
    ],
    beats: [
      [0, "intro"], [7.0, "approach"], [11.0, "charge", "a"], [12.2, "clash"],
      [15.0, "charge", "b"], [16.2, "retreat", "a"], [19.0, "flee", "b"], [22.0, "roar", "a"],
    ],
    facts: [
      "The first Baryonyx was found in 1983 by amateur fossil hunter William Walker in a Surrey clay pit.",
      "Its stomach held scales of the fish Lepidotes and bones of a young Iguanodon, so it ate more than fish.",
      "Iguanodon's cone-shaped thumb spike may have been used for defence or for breaking open food.",
    ],
    videos: [],
  },
  {
    id: "deino-vs-deino",
    title: "Deinonychus vs Deinonychus",
    subtitle: "Cloverly Formation · 115 million years ago",
    era: "Early Cretaceous",
    kind: "fossil",
    a: "deinonychus", b: "deinonychus", duration: 24, mood: "dusk",
    lines: [
      [0.5, "CLOVERLY FORMATION, MONTANA — 115 MILLION YEARS AGO"],
      [3.0, "Two Deinonychus arrive at the same kill, a fallen Tenontosaurus."],
      [7.0, "Each one raises its feathered arms and hisses a warning."],
      [11.0, "One leaps, slashing with the big sickle claws on its feet."],
      [15.0, "They may not have been loyal pack-mates. Rivals probably fought over food."],
      [19.0, "The smaller one backs off. The winner gets to eat first."],
      [22.0, "Deinonychus changed how scientists saw dinosaurs: fast, agile and bird-like."],
    ],
    beats: [
      [0, "intro"], [3.0, "approach"], [7.0, "roar", "a"], [8.4, "roar", "b"],
      [11.0, "charge", "a"], [12.2, "clash"], [15.0, "circle"], [17.0, "clash"],
      [19.0, "flee", "b"], [22.0, "roar", "a"],
    ],
    facts: [
      "Deinonychus teeth are often found with Tenontosaurus skeletons, so it hunted or scavenged them.",
      "Some scientists think Deinonychus mobbed prey like Komodo dragons rather than hunting as a team.",
      "John Ostrom's 1964 discovery of Deinonychus helped show that birds are living dinosaurs.",
    ],
    videos: [],
  },
  {
    id: "giganoto-vs-mapu",
    title: "Giganotosaurus vs Mapusaurus",
    subtitle: "Neuquén, Patagonia · about 97 million years ago",
    era: "Late Cretaceous",
    kind: "whatif",
    a: "giganoto", b: "mapu", duration: 26, mood: "sunset",
    lines: [
      [0.5, "NEUQUÉN, PATAGONIA — ABOUT 97 MILLION YEARS AGO"],
      [3.5, "Two giant carcharodontosaurs meet at the carcass of a titanosaur."],
      [7.5, "Giganotosaurus, one of the largest meat-eaters ever, steps forward."],
      [11.5, "Mapusaurus answers with a roar. It is almost as big."],
      [15.5, "A bonebed of several Mapusaurus hints that they may have lived in groups."],
      [19.5, "Jaws clash over the carcass. Neither giant backs down."],
      [23.0, "These cousins lived in the same region, probably a few million years apart."],
    ],
    beats: [
      [0, "intro"], [3.5, "approach"], [7.5, "roar", "a"], [11.5, "roar", "b"],
      [13.5, "circle"], [19.5, "clash"], [21.2, "clash"], [23.0, "standoff"],
    ],
    facts: [
      "Giganotosaurus comes from the Candeleros Formation; Mapusaurus from the slightly younger Huincul Formation.",
      "One bonebed held at least seven Mapusaurus of different ages, hinting at group behaviour.",
      "Both were close relatives of Carcharodontosaurus, with skulls longer than a person is tall.",
    ],
    videos: [],
  },
  {
    id: "allo-vs-torvo",
    title: "Allosaurus vs Torvosaurus",
    subtitle: "Morrison Formation · 150 million years ago",
    era: "Late Jurassic",
    kind: "coexisted",
    a: "allo", b: "torvo", duration: 24, mood: "dusk",
    lines: [
      [0.5, "MORRISON FORMATION — 150 MILLION YEARS AGO"],
      [3.0, "Two big predators claim the same hunting ground."],
      [7.0, "Allosaurus is quicker. Torvosaurus is bigger, with a heavier, deeper skull."],
      [11.0, "They circle and bluff, each waiting for the other to make a mistake."],
      [15.0, "A lunge, a bite, and the smaller predator gives way."],
      [19.0, "In the Morrison, big meat-eaters were a danger to each other as well as to their prey."],
      [22.0, "Torvosaurus was one of the largest predators of the Jurassic."],
    ],
    beats: [
      [0, "intro"], [3.0, "approach"], [7.0, "roar", "b"], [9.0, "roar", "a"],
      [11.0, "circle"], [15.0, "charge", "b"], [16.2, "clash"], [17.6, "retreat", "a"],
      [19.0, "flee", "a"], [22.0, "roar", "b"],
    ],
    facts: [
      "Torvosaurus could reach around 10 metres long, larger than a typical Allosaurus.",
      "Allosaurus bones from a Colorado quarry carry Allosaurus tooth marks, so they scavenged, or ate, each other.",
      "Torvosaurus means 'savage lizard'.",
    ],
    videos: [],
  },
  {
    id: "quetzal-vs-ptero",
    title: "Quetzalcoatlus vs Pteranodon",
    subtitle: "What if? · 20 million years apart",
    era: "Late Cretaceous",
    kind: "whatif",
    a: "quetzal", b: "ptero", duration: 24, mood: "sky",
    lines: [
      [0.5, "A WHAT-IF SCREENING — THESE FLYERS LIVED 20 MILLION YEARS APART"],
      [3.0, "A Pteranodon glides over the sea, its long crest steering in the wind."],
      [7.0, "A much larger shape rises on the warm air: Quetzalcoatlus."],
      [11.0, "With wings around 10 metres across, it was as big as a small plane."],
      [15.0, "The smaller flyer banks away over the open water."],
      [19.0, "Quetzalcoatlus probably hunted on the ground, snapping up small animals like a giant stork."],
      [22.0, "Pteranodon lived about 85 million years ago; Quetzalcoatlus about 68 million years ago."],
    ],
    beats: [
      [0, "intro"], [3.0, "approach"], [7.0, "circle"], [11.0, "roar", "a"],
      [12.8, "charge", "a"], [15.0, "flee", "b"], [19.0, "circle"],
    ],
    facts: [
      "Quetzalcoatlus is one of the largest flying animals ever, with a wingspan of around 10–11 metres.",
      "Pteranodon had no teeth; fish remains found with its fossils show it ate fish.",
      "Pterosaurs were flying reptiles, not dinosaurs, but they were close cousins.",
    ],
    videos: [],
  },
  {
    id: "trike-vs-centro",
    title: "Triceratops vs Centrosaurus",
    subtitle: "What if? · Alberta, 10 million years apart",
    era: "Late Cretaceous",
    kind: "whatif",
    a: "trike", b: "centro", duration: 24, mood: "plains",
    lines: [
      [0.5, "A WHAT-IF SCREENING — ALBERTA, CANADA"],
      [3.0, "Centrosaurus roamed Alberta about 76 million years ago, in huge herds."],
      [7.0, "Triceratops lived there about 10 million years later, and it was much bigger."],
      [11.0, "The two horned dinosaurs lower their heads and lock horns."],
      [15.0, "Triceratops has three horns and a solid frill. Centrosaurus has one big nose horn."],
      [19.0, "Shoving matches like this were probably about rank, not killing."],
      [22.0, "Healed wounds on horned dinosaur skulls show they really did fight."],
    ],
    beats: [
      [0, "intro"], [3.0, "approach"], [7.0, "roar", "b"], [11.0, "clash"],
      [13.0, "clash"], [15.0, "standoff"], [17.0, "clash"], [19.0, "retreat", "b"],
      [22.0, "standoff"],
    ],
    facts: [
      "Bonebeds in Alberta hold the remains of hundreds, even thousands, of Centrosaurus, probably drowned in floods.",
      "Healed injuries on Triceratops skulls match the damage expected from horn-locking fights.",
      "Triceratops could reach about 9 metres long; Centrosaurus about 6 metres.",
    ],
    videos: [],
  },
  {
    id: "dilo-vs-coelo",
    title: "Dilophosaurus vs Coelophysis",
    subtitle: "Kayenta Formation · about 190 million years ago",
    era: "Early Jurassic",
    kind: "coexisted",
    a: "dilo", b: "coelo", duration: 22, mood: "desert",
    lines: [
      [0.5, "KAYENTA FORMATION, ARIZONA — ABOUT 190 MILLION YEARS AGO"],
      [3.0, "A small, slender coelophysid picks at a carcass in the river valley."],
      [7.0, "A crested shadow falls over it: Dilophosaurus, the biggest hunter around."],
      [11.0, "The newcomer rears up and shows off its double crest."],
      [15.0, "The little hunter darts in for one last bite, then flees."],
      [19.0, "Those thin crests were probably for display, not for fighting."],
    ],
    beats: [
      [0, "intro"], [7.0, "approach"], [11.0, "roar", "a"], [15.0, "charge", "b"],
      [16.0, "retreat", "b"], [17.0, "flee", "b"], [19.0, "roar", "a"],
    ],
    facts: [
      "The little coelophysid of the Kayenta was once named Coelophysis kayentakatae; it is now often called Megapnosaurus.",
      "Real Dilophosaurus had no neck frill and no venom; those were invented for Jurassic Park.",
      "At about 7 metres long, Dilophosaurus was one of the largest predators of the Early Jurassic.",
    ],
    videos: [],
  },
];

/**
 * Video-only screenings (no in-engine version), e.g. documentary clips of
 * match-ups that are not in BATTLES. Filled by the lead:
 *   { id: "<11-char YouTube id>", title, channel, matchup: "Spinosaurus vs T. rex" }
 */
export const EXTRA_SCREENINGS = [];

/**
 * Merge verified YouTube data into the programme.
 *   applyBattleVideos({ battles: { "<battleId>": [{ id, title, channel }] }, extra: [...] })
 * Unknown battle ids and malformed video ids are ignored.
 */
export function applyBattleVideos(data = {}) {
  const ok = (v) => v && typeof v.id === "string" && /^[A-Za-z0-9_-]{11}$/.test(v.id);
  for (const [battleId, vids] of Object.entries(data.battles || {})) {
    const battle = BATTLES.find((b) => b.id === battleId);
    if (!battle || !Array.isArray(vids)) continue;
    for (const v of vids) {
      if (ok(v) && !battle.videos.some((x) => x.id === v.id)) battle.videos.push({ ...v });
    }
  }
  for (const v of data.extra || []) {
    if (ok(v) && !EXTRA_SCREENINGS.some((x) => x.id === v.id)) EXTRA_SCREENINGS.push({ ...v });
  }
  return { battles: BATTLES, extra: EXTRA_SCREENINGS };
}

export const FACTS = [
  "Dinosaurs lived for about 165 million years — nearly three times longer than humans have existed.",
  "There was a period called the 'Cretaceous Terrestrial Revolution' when flowering plants changed everything.",
  "Birds are living dinosaurs — the only lineage to survive the K-Pg extinction.",
  "Some dinosaurs were metres tall, but the heaviest were sauropods weighing over 50 tonnes.",
  "A single Triceratops skull can measure more than 2.5 metres from tip to frill.",
  "Dinosaur footprints reveal behaviour: they show herds, nests and even courtship dances.",
  "Not every dinosaur was a giant — the average species was about the size of a large dog.",
  "Sue, the most famous T. rex, is 90% complete — a fossil record rarity.",
  "Some dinosaurs had feathers, and we know it because of microscopic structures preserved in the rock.",
  "The name 'dinosaur' means 'terrible lizard', coined by Sir Richard Owen in 1842.",
  "Giraffe, rhinoceros and crocodile are all closer relatives to a dinosaur than a T. rex is.",
  "Dinosaur coprolites (fossil dung) show what they ate — including plants, bones and even pine nuts.",
  "A herd of Parasaurolophus could once have been heard across kilometres by its crest.",
  "The first dinosaur to be formally named was the Megalosaurus, in 1824.",
  "Tyrannosaurus, Triceratops and Ankylosaurus all lived in the last two million years of the Cretaceous.",
  "Palaeontologists often name new dinosaurs after the rock they were found in.",
  "Feathered dinosaurs like Velociraptor were probably far more bird-like than we used to imagine.",
  "Some sauropods had air sacs in their vertebrae, like balloons in a bird's body.",
  "The La Brea Tar Pits have preserved thousands of late Ice Age fossils in Los Angeles.",
  "Dinosaur bones grow back in herds: a single skeleton can make hundreds of specimens.",
  "Oviraptor was named 'egg thief' for the wrong crime — the eggs were almost certainly its own.",
  "Ammonites were marine cousins of the nautilus, and some were as large as a car.",
  "No dinosaur ever reached the size of a blue whale — that title still belongs to today's animals.",
  "Dinosaur skin impressions show scaly skin, stripes and even patches of colour.",
  "The oldest dinosaur nests, found in Montana, contain eggs that may have been incubated by body heat.",
];

export function exhibitById(id) {
  return EXHIBITS.find((e) => e.id === id);
}
export function battleById(id) {
  return BATTLES.find((b) => b.id === id);
}
export { SPECIES, SPECIES_LIST };
