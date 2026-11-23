'use strict';
// Pages lisibles par Google : une page par prestation et par lieu (Paris par arrondissement, villes proches),
// avec le plan du site (sitemap.xml) et robots.txt. Le site lui-même reste l'application habituelle.
const pricing = require('./pricing');

const PARIS = {
  1: 'Les Halles, Palais-Royal, place Vendôme', 2: 'Bourse, Sentier, Montorgueil', 3: 'Haut-Marais, Arts-et-Métiers, Temple',
  4: 'Marais, île Saint-Louis, Hôtel de Ville', 5: 'Quartier latin, Panthéon, Jardin des Plantes', 6: 'Saint-Germain-des-Prés, Odéon, Luxembourg',
  7: 'Invalides, Gros-Caillou, Faubourg Saint-Germain', 8: 'Champs-Élysées, Madeleine, Europe', 9: 'Opéra, Saint-Georges, Grands Boulevards',
  10: 'Canal Saint-Martin, gare du Nord, gare de l\'Est', 11: 'Oberkampf, Bastille, Charonne', 12: 'Bercy, Nation, Bel-Air',
  13: 'Butte-aux-Cailles, Paris Rive Gauche, Gobelins', 14: 'Montparnasse, Alésia, Denfert-Rochereau', 15: 'Vaugirard, Grenelle, Javel',
  16: 'Passy, Auteuil, Trocadéro', 17: 'Batignolles, Ternes, plaine Monceau', 18: 'Montmartre, Abbesses, Jules-Joffrin',
  19: 'Buttes-Chaumont, La Villette, Jourdain', 20: 'Belleville, Ménilmontant, Gambetta',
};
const TOWNS = [
  ['boulogne-billancourt', 'Boulogne-Billancourt', '92100'], ['neuilly-sur-seine', 'Neuilly-sur-Seine', '92200'], ['levallois-perret', 'Levallois-Perret', '92300'],
  ['issy-les-moulineaux', 'Issy-les-Moulineaux', '92130'], ['courbevoie', 'Courbevoie', '92400'], ['puteaux', 'Puteaux', '92800'],
  ['saint-cloud', 'Saint-Cloud', '92210'], ['rueil-malmaison', 'Rueil-Malmaison', '92500'], ['clichy', 'Clichy', '92110'],
  ['nanterre', 'Nanterre', '92000'], ['vincennes', 'Vincennes', '94300'], ['saint-mande', 'Saint-Mandé', '94160'],
  ['montreuil', 'Montreuil', '93100'], ['saint-denis', 'Saint-Denis', '93200'], ['versailles', 'Versailles', '78000'],
];
const PLACES = [
  ...Object.entries(PARIS).map(([n, q]) => ({ slug: `paris-${n}`, name: `Paris ${n}${n === '1' ? 'er' : 'e'}`, cp: `750${String(n).padStart(2, '0')}`, around: q })),
  ...TOWNS.map(([slug, name, cp]) => ({ slug, name, cp, around: null })),
];
const IDF = pricing.GRID.IDF;
const SERVICES = {
  'menage-a-domicile': {
    service: 'menage', h1: (p) => `Ménage à domicile à ${p.name}`, short: 'Ménage à domicile',
    price: `${IDF.menage} € de l'heure`,
    intro: (p) => `Une intervenante vérifiée vient chez vous à ${p.name}${p.around ? ` (${p.around})` : ''}, une fois ou chaque semaine. Vous choisissez la date et l'heure, le prix total s'affiche avant de payer.`,
    points: ['Cuisine, salle de bain, sols, poussière, poubelles', 'La même intervenante à chaque passage si vous le souhaitez', 'Options : repassage, vitres, four, réfrigérateur, draps', 'Abonnement chaque semaine ou toutes les deux semaines : −5 %', 'Annulation gratuite jusqu\'à 24 h avant'],
  },
  'menage-airbnb': {
    service: 'airbnb', h1: (p) => `Ménage Airbnb à ${p.name}`, short: 'Ménage Airbnb',
    price: `dès ${IDF.airbnb.studio} € le logement, linge compris`,
    intro: (p) => `Entre deux voyageurs, une intervenante fait le ménage et change le linge de votre logement à ${p.name}. Reliez le calendrier de votre annonce : un ménage est proposé après chaque départ.`,
    points: ['Forfait par taille : studio, 2 pièces, 3 pièces, maison', 'Ménage complet, lits faits, réassort', 'Calendrier Airbnb, Abritel ou Booking synchronisé', 'Une intervenante préférée par logement', 'Photos avant / après sur demande'],
  },
  'nettoyage-bureaux': {
    service: 'bureau', h1: (p) => `Nettoyage de bureaux à ${p.name}`, short: 'Nettoyage de bureaux',
    price: `${Math.round((IDF.bureau / 1.2) * 100) / 100} € HT de l'heure`.replace('.', ','),
    intro: (p) => `Le ménage de vos locaux à ${p.name}, avant l'ouverture ou après la fermeture, de 6 h à 22 h. Une intervenante régulière et une facture au nom de votre société.`,
    points: ['Postes de travail, sols, sanitaires, coin café, salles de réunion', 'Créneaux tôt le matin ou le soir', 'Facture avec TVA au nom de la société', 'Remise de 5 à 10 % selon le volume du mois', 'Devis gratuit pour les grands locaux'],
  },
};

const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(kind, slug, base) {
  const S = SERVICES[kind];
  const p = PLACES.find((x) => x.slug === slug);
  if (!S || !p) return null;
  const url = `${base}/${kind}/${p.slug}`;
  const title = `${S.h1(p)} : prix, intervenantes vérifiées | Proprigo`;
  const desc = `${S.h1(p)} avec Proprigo : ${S.price}. Intervenantes vérifiées, prix affiché avant de payer, réservation en ligne en 2 minutes.`;
  const others = Object.entries(SERVICES).filter(([k]) => k !== kind).map(([k, o]) => `<a href="/${k}/${p.slug}">${esc(o.short)} à ${esc(p.name)}</a>`).join(' · ');
  const near = PLACES.filter((x) => x.slug !== p.slug).slice(0, 35).map((x) => `<a href="/${kind}/${x.slug}">${esc(x.name)}</a>`).join(' ');
  const ld = { '@context': 'https://schema.org', '@type': 'Service', name: S.h1(p), serviceType: S.short, areaServed: { '@type': 'Place', name: p.name, address: { '@type': 'PostalAddress', postalCode: p.cp, addressCountry: 'FR' } }, provider: { '@type': 'Organization', name: 'Proprigo', url: base } };
  const cta = kind === 'nettoyage-bureaux' ? `${base}/#/pro` : `${base}/#/?cp=${p.cp}`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${esc(url)}">
<meta property="og:title" content="${esc(S.h1(p))}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(url)}">
<link rel="icon" href="/logo.svg"><link rel="stylesheet" href="/styles.css">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script></head><body>
<header class="top"><div class="in"><a class="brand" href="/"><img src="/logo.svg" alt="" width="36" height="36"> proprigo</a><nav class="seo-nav"><a href="/#/pro">Entreprises</a><a class="cta" href="${esc(cta)}">Réserver</a></nav></div></header>
<main class="wrap seo">
  <section class="hello"><div class="hello-text"><p class="hello-hi">${esc(p.cp)} · ${esc(p.name)}</p><h1>${esc(S.h1(p))}</h1><p class="hello-sub">${esc(S.intro(p))}</p>
    <a class="btn primary" href="${esc(cta)}">${kind === 'nettoyage-bureaux' ? 'Demander un devis' : 'Voir les créneaux'}</a></div></section>
  <section class="card"><h2>${esc(S.price)}</h2><ul class="seo-list">${S.points.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <p class="small muted">${kind === 'nettoyage-bureaux' ? 'Prix hors taxes en Île-de-France, TVA de 20 % en plus.' : 'Prix TTC en Île-de-France.'} Dimanche et jours fériés : +20 %.${kind === 'menage-airbnb' ? '' : ' Matériel apporté : +15 €.'}</p></section>
  <section class="card"><h2>Comment ça marche</h2><ol class="flow"><li><b>Vous réservez en 2 minutes</b><span>La date, l'heure et le prix total, avant de payer.</span></li><li><b>Une intervenante vérifiée vient</b><span>Identité vérifiée, entretien, suivi de la qualité. Vous voyez son prénom avant le ménage.</span></li><li><b>Vous suivez tout</b><span>En route, arrivée, checklist, reçu : tout est dans votre espace.</span></li></ol></section>
  <section class="card"><h2>Aussi à ${esc(p.name)}</h2><p>${others}</p><h2 style="margin-top:16px">${esc(S.short)} ailleurs</h2><p class="seo-places">${near}</p></section>
</main>
<footer class="foot"><div class="in"><span>© Proprigo · ménage à la demande en Île-de-France</span><nav><a href="/#/aide">Aide</a> <a href="/#/cgv">CGV</a> <a href="/#/mentions-legales">Mentions légales</a></nav></div></footer>
</body></html>`;
}

function sitemap(base) {
  const urls = [`${base}/`, ...Object.keys(SERVICES).flatMap((k) => PLACES.map((p) => `${base}/${k}/${p.slug}`))];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join('\n')}\n</urlset>\n`;
}
const robots = (base) => `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${base}/sitemap.xml\n`;

module.exports = { page, sitemap, robots, PLACES, SERVICES };
