# Editeur PDF — version web

https://pdf-editeur.vercel.app

Meme moteur que la version locale, **entierement porte dans le navigateur** : aucun serveur,
aucun envoi. Le document reste sur l'appareil, y compris sur telephone.

## Pourquoi un portage plutot qu'un deploiement du serveur Python

Le moteur local repose sur Tesseract, OpenCV et PyMuPDF, des binaires systeme. Une fonction
Vercel ne permet pas d'installer Tesseract (pas d'`apt`), et l'ensemble depasserait de loin
la limite de taille d'une fonction. Le portage remplace chaque brique par son equivalent
navigateur :

| Local (Python) | Web |
|---|---|
| PyMuPDF (rendu) | pdf.js |
| PyMuPDF (ecriture) | pdf-lib |
| Tesseract | tesseract.js (WebAssembly) |
| OpenCV | traitement pixel maison sur `ImageData` |
| polices systeme | 28 polices allegees en woff2 (544 Ko) |

## Ce qui est identique

Toute la logique de fidelite est reprise telle quelle : mesure de la couleur de l'encre au
coeur du trait et du papier autour, reconnaissance de la police par comparaison de pixels sur
des mots isoles, inclinaison mesuree par cisaillement, graisse par epaisseur de trait,
interlettrage plafonne, et surtout la **texture** — irregularites d'encrage, raideur des
contours, bruit du capteur — sans laquelle un trace neuf se repere au premier coup d'oeil.

## Ce qui differe

- **L'effacement** : faute d'OpenCV, le fond est reconstitue par interpolation depuis les
  bords de la zone au lieu d'un inpainting TELEA. Sur du texte pose sur un papier le resultat
  est equivalent ; sur un fond tres structure il l'est moins.
- **Les PDF natifs** : la version locale extrait la police embarquee et reecrit le texte en
  vectoriel. Ici, toute retouche passe par une image incrustee, comme pour un scan. Seule la
  zone modifiee est concernee, a la resolution du document.
- **La premiere reconnaissance** telecharge le moteur OCR et les donnees de langue
  (environ 8 Mo), mis en cache ensuite.

## Mobile

Teste en portrait et en paysage sur iPhone emule, encoche et barre d'accueil simulees : rien
ne passe sous les zones de securite, aucun defilement horizontal, cibles tactiles d'au moins
40 px. Pincement a deux doigts et double-tap pour zoomer, feuille d'edition venant du bas en
portrait, panneau lateral en paysage.
