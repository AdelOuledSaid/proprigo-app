# Proprigo v1.9.0 — 11 améliorations

## Client
- **Avec qui ?** À la réservation, le client choisit une intervenante déjà venue chez lui (sa préférée est cochée d'office) ou « Peu importe ». Les créneaux ★ montrent quand elle est libre.
- **Pourboire** sur un ménage terminé (2, 5, 10 € ou autre, jusqu'à 50 €), dans les 30 jours. Payé par carte (Stripe), reversé à 100 % : ajouté au versement des indépendantes, dans l'export de paie des salariées. L'intervenante est prévenue (e-mail + notification).
- **Rappel la veille** à partir de 17 h (plus jamais la nuit) : e-mail + notification, au client (« pensez aux clés ou au code ») et à l'intervenante.

## Intervenante
- **Documents qui expirent** (titre de séjour, attestation URSSAF : 6 mois par défaut, assurance) : date « valable jusqu'au », alertes à 30 jours et 7 jours (elle + vous), et à l'expiration plus de nouvelles missions jusqu'à validation de la nouvelle version. Bouton « Envoyer la nouvelle version ».
- **Relevé mensuel** (Mes gains › Historique › 📄 Relevé) : missions, heures, bonus Platine, pourboires, versements reçus ; imprimable en PDF.
- **Langues** : français, português, español, العربية (de droite à gauche), choix en haut de l'espace. Les messages, consignes et adresses ne sont jamais traduits ; les messages rapides envoyés au client restent en français.
- **Itinéraire de la journée** : Google Maps avec toutes les adresses du jour dans l'ordre (à partir de 2 missions).

## Admin
- **Absence non prévenue** (bouton sur la réservation, le jour même ou après) : la mission repart à attribuer, l'intervenante est prévenue, et pas de Platine pendant 6 mois.
- **Paie des salariées** (Paiements › CSV) : ménages, heures, dont dimanches et jours fériés, niveau, prime Platine, pourboires, absences, congés.
- **Virement groupé SEPA** : l'indépendante enregistre son IBAN (vérifié, vous êtes prévenu à chaque changement) ; un fichier à importer dans votre banque ; puis « tout marquer versé ». Ajoutez l'IBAN de Proprigo dans `config/entreprise.json` (champs `iban` et `bic`).
- **Notes partagées** : une note sur un client peut être montrée à l'intervenante sur ses missions chez lui (« 📝 À savoir »), jamais au client.
