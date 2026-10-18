# Crustrusk

Modular, adjustable column-staggered (split) keyboard project

## Features
- adjustable stagger / modular PCBs
- implement up to 5x7+7 column stagger keyboard
- support I2C / SPI communication for peripherals

## What it can do
- default bundle can give you 3x7+3 keyboard with knob
  - e.g. corne with extra key in inner column & knob
- adjusting stagger to fit your hand
  - you can make it ortho too
- adjusting splay to fit your hand
- (technically) support display, trackball, touchpad, etc.
- implement:
  - Corne
  - Cheapino
  - Sweep
  - Sofle
  - Cornix
  - Flake
  - Totem (with custom column PCB)
  - Jian (with custom column PCB)
  - Lily58 (with custom column PCB)
  - Kyria
  - Ergodox
  - Moonlander
  - Crosses (technically)
  - ...

## What it cannot do
- keywell structure, unless PCB is modified that key
- row-staggered
- semi-staggered

## Remarks
### Production
- current version of 'bundle' is not production tested
  - old gerber that is initially committed was tested, although JST sockets on the main board had to be flipped.
  - male to male connector tips to face the same side: [reminder](https://github.com/ReSummit/Seismos#important-notes-for-building-keyboard)
- all PCB here are MX, but transition should be feasible
- bundles will, ideally, be sub-102x102 mm for cheap fabrication
### Engineering decisions
- JST PH socket is chosen because:
  - cheap, flexible, easy to solder, not too big
  - it's not the most aesthetic / professional choice
  - smaller JST sockets are SMD and harder to solder with small pitch
    - they do offer smaller height and greater surface, though
  - FFC sockets are great, but the sided nature and flexibilities were my concern
- 6 pins for general case was used as:
  - some popular keyboards have 5-key column / thumb cluster, and I wanted to cover them
- 8 pins for extended thumb / peripheral was used as:
  - Ergodox / Kyria uses 6+ key thumb cluster
  - to support SPI / trackballs
  - high potential for peripheral development
- RP2040-zero was used as it's easy to solder without pins and exposes more pins
  - changing it to Pro-micro / xiao (with some sacrifices) shouldn't be too hard
  - core is ugly. Improvement is needed.
- currently, M2 screws & standoffs are used to fix the keyboard & adjust stagger.
### Building tips
- it'd be easier to use SMD diodes as THT diodes' leg might be touching the switches. I cut legs tightly and it was fine.
- web app for generating QMK config for various combinations are under way

## Inspirations
- [Zebra](https://github.com/nezumee/zebra)
- [Seismos](https://github.com/ReSummit/Seismos)
- [Pangaea](https://github.com/e3w2q/Pangaea-keyboard/tree/main)
- [Pineapple60-P4](https://github.com/saoto28/pineapple60/tree/main/p4)
- [Squalius-cephalus's modular keyboard](https://www.reddit.com/r/ErgoMechKeyboards/comments/1l3c5us/diy_modular_split_keyboard/)

## Disclaimer
- Any layout / designs used in this project that originates from other repositories (e.g. thumb clusters) follows the original author's license.
