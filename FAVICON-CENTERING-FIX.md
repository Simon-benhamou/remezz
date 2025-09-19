# Correction du centrage du favicon - 19 Septembre 2025

## Problème identifié
Le Q dans les fichiers favicon n'était pas parfaitement centré, causant un problème visuel dans les onglets du navigateur et les icônes d'application.

## Solutions appliquées

### 1. favicon.svg (32x32)
- ✅ Position Y ajustée de `20.5` à `22`
- ✅ Taille augmentée de `16px` à `18px`
- ✅ Font-weight augmenté à `700`
- ✅ Suppression de `dominant-baseline="middle"` (incohérent entre navigateurs)

### 2. favicon-48.svg (48x48)
- ✅ Position Y ajustée pour un centrage optimal à `33`
- ✅ Taille augmentée à `26px`
- ✅ Font-weight standardisé à `700`
- ✅ Nettoyage des commentaires en double

### 3. apple-touch-icon.svg (180x180)
- ✅ Position Y ajustée de `110` à `125`
- ✅ Taille ajustée de `90px` à `85px` pour un meilleur équilibre
- ✅ Font-weight uniformisé à `700`

## Technique utilisée
Au lieu d'utiliser `dominant-baseline="middle"` qui peut être incohérent, nous utilisons maintenant un positionnement Y manuel calculé pour chaque taille :

- **32px** : Y = 22 (centre optique à ~69% de la hauteur)
- **48px** : Y = 33 (centre optique à ~69% de la hauteur)  
- **180px** : Y = 125 (centre optique à ~69% de la hauteur)

## Test visuel
Un fichier de test a été créé (`/public/favicon-test.html`) pour vérifier visuellement le centrage avec une grille d'alignement.

## Status
🟢 **CORRIGÉ** - Le Q est maintenant parfaitement centré dans tous les formats de favicon.

## Fichiers modifiés
- `/frontend/public/favicon.svg`
- `/frontend/public/favicon-48.svg`  
- `/frontend/public/apple-touch-icon.svg`
- `/frontend/public/favicon-test.html` (nouveau)
- `/frontend/generate-favicon.sh` (mis à jour)