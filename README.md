# Editeur PDF local

Une application web qui tourne **entierement sur votre machine** : aucun document n'est
envoye sur Internet. Elle modifie aussi bien les PDF natifs que les **documents scannes**,
en reproduisant la police, la couleur de l'encre et le grain du papier d'origine.

## Lancer

Depuis Windows, double-cliquer **Editeur PDF.cmd** sur le Bureau : le serveur demarre dans
WSL s'il ne tourne pas deja, puis l'application s'ouvre dans une fenetre Chrome dediee.
`Arreter Editeur PDF.cmd` arrete le serveur (rarement necessaire, il ne consomme rien au
repos et ne redemarre pas tout seul apres extinction du PC).

Depuis un terminal :

```bash
./run.sh            # puis ouvrir http://localhost:8420
./run.sh 9000       # sur un autre port
```

Le raccourci `Editeur PDF.lnk` (avec l'icone) est genere par `installer_raccourci.ps1`. Windows
Defender refuse qu'un script depose un `.lnk` pointant vers un `.cmd` sur le Bureau : il faut
donc le glisser soi-meme depuis l'Explorateur, ou se contenter du `.cmd`, qui fonctionne aussi
bien mais porte l'icone generique des fichiers de commande.

## Ce qu'elle sait faire

| Outil | Effet |
|---|---|
| **Texte** | Clic sur un texte de la page, modification, application |
| **Gomme** | Efface une zone en reconstituant le fond |
| **Ajouter** | Nouveau bloc de texte n'importe ou |
| **Image** | Insere une image ou une signature |
| **Relire** | Force la relecture de la page dans l'autre mode (OCR ou texte natif) |
| Panneau des pages | Rotation, suppression |
| Telecharger | Export du PDF modifie |

Raccourcis : `Ctrl+Z` annuler, `Ctrl+Entree` appliquer, `Echap` deselectionner,
fleches gauche/droite pour changer de page.

## Comment la fidelite est obtenue

L'application distingue deux natures de page et ne les traite pas pareil.

**Page native** (texte vectoriel). Le texte d'origine est retire, puis reecrit avec la
police **reellement embarquee dans le PDF**, extraite du fichier et reinjectee. Le rendu
est donc identique a l'original. Un PDF n'embarque souvent qu'un sous-ensemble des
glyphes utilises : si le texte saisi contient une lettre absente de ce sous-ensemble,
l'application le detecte et bascule sur la police systeme la plus proche plutot que de
produire des caracteres vides.

**Page scannee** (une simple image). Rien dans le fichier ne dit quelle police a ete
utilisee : tout est deduit de l'image.

1. **Reperage** : la page est rendue a la resolution native du scan (et non a une valeur
   fixe), puis Tesseract lit les lignes de texte. Cela change beaucoup : a 200 dpi, un
   corps de 8 pt ne fait que 22 px de haut, trop peu pour mesurer une epaisseur de trait
   ou departager deux polices. Les lignes sont coupees sur les grands blancs, pour qu'un
   libelle et son montant dans un tableau restent editables separement.
2. **Couleurs** : le crop est separe en encre / papier par seuillage d'Otsu. La couleur
   de l'encre est prise au coeur du trait (apres erosion, pour ne pas la delaver avec
   l'anti-aliasing) ; celle du papier sur une bande elargie autour du texte. Le texte
   clair sur fond sombre est gere.
3. **Police** : la comparaison porte sur quelques **mots isoles**, jamais sur la ligne
   entiere. Sur soixante caracteres, un ecart d'espacement minime decale la fin du trace
   et fait s'effondrer le recouvrement de toutes les polices a la fois : le classement ne
   veut alors plus rien dire, et c'est ainsi qu'un corps de texte sans empattements
   ressortait en serif. Sur des mots dont l'OCR donne la position exacte, il n'y a pas de
   derive a rattraper. Chaque police installee redessine ces mots, a la taille observee et
   avec le flou mesure sur le scan, puis est comparee au document (IoU des masques
   d'encre + proximite de chasse). La mieux notee gagne. Trois details comptent :
   - le **flou du scan** est mesure et applique aux candidats. Sans cela, l'empatement du
     texte numerise gonfle sa hauteur d'encre d'environ 10 % mais sa largeur de 1 %, et
     tout finit par ressembler a une police condensee et grasse ;
   - l'**italique** est mesure, pas devine : on cisaille le masque a differents angles et
     on garde celui qui redresse les futs. La pente propre de la ligne est retiree au
     prealable, sans quoi un document photographie de travers passerait pour de
     l'italique ;
   - la **graisse** est tranchee par l'epaisseur reelle du trait (transformee de
     distance) plutot que par la ressemblance globale, ou un gras gagnait simplement
     parce qu'il est plus large. Cette mesure n'etant fiable que sur du texte net et
     assez grand, elle ne s'applique que dans ce cas.

   Mesure sur des scans simules (bruit + JPEG) : **84 % de police exacte, 92 % de famille
   correcte**. Le score de concordance est affiche dans l'interface, et un point orange
   signale les zones peu fiables : la police reste modifiable en un clic.
4. **Corps et espacement** : la taille vient de la hauteur d'encre (elle ne depend pas de
   la chasse, donc reste juste meme si la police devinee n'est pas exacte), puis un
   leger interlettrage rattrape la largeur pour que le texte reoccupe la meme place.
   Cet interlettrage est plafonne a 6 % du corps et ne touche pas les espaces : resserrer
   les mots entre eux se remarque bien plus qu'une ligne un peu plus courte.
5. **Texture** : le texte redessine n'est pas pose net, il subit la meme chaine que le
   document d'origine. C'est le point qui trahit le plus une retouche, avant meme la
   forme des lettres. Un scan n'est pas flou, il est **aliase** : ses transitions
   encre/papier tiennent en un pixel, la ou le rendu d'une police les etale en un degrade
   regulier. On mesure donc la raideur reelle des contours et on l'applique au trace,
   avec les irregularites d'encrage et le bruit du capteur. Meme raison pour la zone
   effacee : l'inpainting rend une surface lisse, a laquelle on redonne le grain du
   papier voisin, sinon la platitude se repere aussitot.
6. **Effacement** : par *inpainting* (OpenCV TELEA) et non par un rectangle blanc, ce qui
   preserve le grain, le jaunissement et le fond colore.
7. **Reincrustation** : seule la zone modifiee est reinseree, **a la resolution native du
   scan**. Le reste de la page n'est ni decode ni reencode : pas de perte de qualite, et
   le fichier ne gonfle pas. Une couche de texte invisible est ajoutee pour que la
   retouche reste cherchable.

## Structure

```
server.py            API FastAPI (local)
pdfcore/fonts.py     catalogue de polices + reconnaissance par comparaison d'images
pdfcore/ocr.py       Tesseract, regroupement en lignes, decoupe des colonnes
pdfcore/raster.py    couleurs, effacement par inpainting, dessin du texte
pdfcore/document.py  analyse des pages, application des modifications, export
static/              interface
tests/               tests du moteur
```

## Tests

```bash
python3 tests/test_fontmatch.py   # precision de la reconnaissance de police
python3 tests/make_samples.py     # fabrique un PDF natif + sa version scannee
python3 tests/test_pipeline.py    # analyse + edition + export sur les deux
```

## Limites connues

- La reconnaissance de police est limitee aux polices **installees sur la machine**
  (Liberation, DejaVu). Une police de marque absente du systeme sera approchee par la
  plus ressemblante.
- Sur un scan tres incline, les lignes reperees restent horizontales : le texte redessine
  ne suit pas l'inclinaison (l'inclinaison est mesuree, mais seulement pour ecarter les
  faux italiques).
- Sur du texte petit ou une image tres bruitee (photo de smartphone), la distinction
  maigre / gras reste incertaine : elle se corrige d'un clic dans le panneau lateral.
- Les langues d'OCR disponibles sont le francais et l'anglais
  (`sudo apt install tesseract-ocr-deu` pour en ajouter).
- Le texte remplace ne se recompose pas automatiquement sur plusieurs lignes : un texte
  beaucoup plus long deborde vers la droite.
