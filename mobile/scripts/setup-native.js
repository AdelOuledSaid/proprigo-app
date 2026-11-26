'use strict';
// Réglages natifs que Capacitor ne fait pas tout seul. Sans risque à relancer.
// - iPhone : transmet le jeton de notification à Capacitor, déclare l'absence de chiffrement propriétaire.
// - Android : rappelle où mettre google-services.json.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const ok = (m) => console.log('  ✓ ' + m);
const todo = (m) => console.log('  ! ' + m);

// ---- iPhone ----
const appDelegate = path.join(root, 'ios/App/App/AppDelegate.swift');
if (fs.existsSync(appDelegate)) {
  let s = fs.readFileSync(appDelegate, 'utf8');
  if (!s.includes('capacitorDidRegisterForRemoteNotifications')) {
    const add = `
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }
`;
    const i = s.lastIndexOf('}');
    s = s.slice(0, i) + add + s.slice(i);
    fs.writeFileSync(appDelegate, s);
    ok('iPhone : notifications branchées dans AppDelegate.swift');
  } else ok('iPhone : notifications déjà branchées');
  const plist = path.join(root, 'ios/App/App/Info.plist');
  if (fs.existsSync(plist)) {
    let p = fs.readFileSync(plist, 'utf8');
    if (!p.includes('ITSAppUsesNonExemptEncryption')) {
      p = p.replace(/<dict>/, '<dict>\n\t<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>');
      fs.writeFileSync(plist, p);
      ok('iPhone : chiffrement standard déclaré (pas de formulaire d\'export à chaque envoi)');
    }
  }
  todo('iPhone : dans Xcode, onglet « Signing & Capabilities », ajoutez « Push Notifications » (une seule fois)');
} else todo('iPhone : projet absent, lancez d\'abord « npx cap add ios »');

// ---- Android ----
const gs = path.join(root, 'android/app/google-services.json');
if (fs.existsSync(path.join(root, 'android'))) {
  if (fs.existsSync(gs)) ok('Android : google-services.json présent (notifications prêtes)');
  else todo('Android : copiez google-services.json (Firebase) dans android/app/ puis relancez « npm run sync »');
}
