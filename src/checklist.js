'use strict';
// Tâches proposées par défaut, selon la prestation. Le client peut les modifier et en ajouter.
const BASE = ['Cuisine : plans de travail, évier, extérieur des appareils', 'Salle de bain et WC', 'Sols : aspirateur et serpillière', 'Poussière des surfaces', 'Vider les poubelles'];
const DEFAULTS = {
  menage: BASE,
  grand: [...BASE, 'Intérieur du four et du réfrigérateur', 'Vitres accessibles', 'Intérieur des placards'],
  bureau: ['Bureaux : poussière des postes de travail, sans déplacer les dossiers', 'Vider les corbeilles et trier les déchets', 'Sols : aspirateur et serpillière', 'Cuisine ou coin café : plans de travail, évier, machine à café', 'Sanitaires : nettoyage et réassort (papier, savon)', 'Salle de réunion : tables et chaises', 'Poignées de porte et interrupteurs'],
  airbnb: [...BASE, 'Changer les draps et les serviettes', 'Faire les lits', 'Réassort : papier toilette, savon, café', "Vérifier l'état du logement et signaler tout dégât"],
};

/** Nettoie une liste envoyée par le navigateur : 1 à 20 tâches de 3 à 100 caractères. */
function clean(list, service) {
  const src = Array.isArray(list) && list.length ? list : DEFAULTS[service] || BASE;
  const tasks = [];
  for (const t of src) {
    const label = String(typeof t === 'object' && t ? t.task : t).replace(/\s+/g, ' ').trim().slice(0, 100);
    if (label.length >= 3 && !tasks.includes(label)) tasks.push(label);
    if (tasks.length === 20) break;
  }
  return tasks.map((task) => ({ task, done: false }));
}

module.exports = { DEFAULTS, clean };
