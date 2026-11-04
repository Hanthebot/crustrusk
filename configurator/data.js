// Board-level facts for the Crustrusk configurator.
//
// These values mirror the main board schematic / PCB:
//   pcb/main_board/main_board.kicad_pcb
//
// Module key layouts live in modules.js, generated from pcb/*/*.kicad_pcb by
// generate-modules.py.

const CONFIG = {
  board: {
    id: 'crustrusk',
    name: 'Crustrusk',
    controller: 'RP2040-Zero',
    diodeDirection: 'COL2ROW',
    split: {
      serialPin: 'GP29',
      sidePin: 'GP28',
    },
    matrixRows: 7,
    rows: [
      { id: 'ROW0', pin: 'GP13', index: 0 },
      { id: 'ROW1', pin: 'GP14', index: 1 },
      { id: 'ROW2', pin: 'GP15', index: 2 },
      { id: 'ROW3', pin: 'GP26', index: 3 },
      { id: 'ROW4', pin: 'GP27', index: 4 },
      { id: 'ROW5', pin: 'GP4', index: 5 },
      { id: 'ROW6', pin: 'GP5', index: 6 },
    ],
    columns: [
      {
        id: 'col0',
        pin: 'GP6',
        label: 'COL0',
        connectorOptions: ['mc6', 'mc8'],
        defaultConnector: 'mc6',
        note: 'MCEX0 shares this column',
      },
      { id: 'col1', pin: 'GP7', label: 'COL1', connectorOptions: ['mc6'], defaultConnector: 'mc6' },
      { id: 'col2', pin: 'GP8', label: 'COL2', connectorOptions: ['mc6'], defaultConnector: 'mc6' },
      { id: 'col3', pin: 'GP9', label: 'COL3', connectorOptions: ['mc6'], defaultConnector: 'mc6' },
      { id: 'col4', pin: 'GP10', label: 'COL4', connectorOptions: ['mc6'], defaultConnector: 'mc6' },
      { id: 'col5', pin: 'GP11', label: 'COL5', connectorOptions: ['mc6'], defaultConnector: 'mc6' },
      { id: 'col6', pin: 'GP12', label: 'COL6', connectorOptions: ['mc6'], defaultConnector: 'mc6' },
      {
        id: 'col7',
        pin: 'GP2',
        label: 'COL7',
        connectorOptions: ['mc6'],
        defaultConnector: 'mc6',
        shares: 'SCK',
        note: 'SCK / COL7',
      },
    ],
    peripheral: {
      connectorOptions: ['mp6', 'mpex8'],
      defaultConnector: 'mp6',
      bus: [
        { name: 'SDA', pin: 'GP0' },
        { name: 'SCL', pin: 'GP1' },
        { name: 'SCK', pin: 'GP2' },
        { name: 'MOSI', pin: 'GP3' },
      ],
      // The 8-pin MPEX connector exposes matrix rows 5 and 6 instead of
      // dedicated GPIO.  They are free only when the build uses <= 5 rows.
      extra: [
        { name: 'ROW5', pin: 'GP4', row: 'ROW5' },
        { name: 'ROW6', pin: 'GP5', row: 'ROW6' },
      ],
    },
  },

  connectors: {
    mc6: {
      id: 'mc6',
      label: 'MC 6-pin',
      short: 'MC6',
      kind: 'module',
      rows: 5,
      map: ['COL', 'ROW0', 'ROW1', 'ROW2', 'ROW3', 'ROW4'],
    },
    mc8: {
      id: 'mc8',
      label: 'MCEX 8-pin',
      short: 'MCEX8',
      kind: 'module',
      rows: 7,
      map: ['COL', 'ROW0', 'ROW1', 'ROW2', 'ROW3', 'ROW4', 'ROW5', 'ROW6'],
    },
    mp6: {
      id: 'mp6',
      label: 'MP 6-pin',
      short: 'MP6',
      kind: 'peripheral',
      map: ['SDA', 'SCL', 'SCK', 'MOSI', 'VCC', 'GND'],
    },
    mpex8: {
      id: 'mpex8',
      label: 'MPEX 8-pin',
      short: 'MPEX8',
      kind: 'peripheral',
      map: ['SDA', 'SCL', 'SCK', 'MOSI', 'ROW5', 'ROW6', 'VCC', 'GND'],
    },
  },

  controllerPins: {
    name: 'RP2040-Zero',
    left: [
      { num: '32', name: '5V', kind: 'power' },
      { num: '31', name: 'GND', kind: 'power' },
      { num: '30', name: '3V3', kind: 'power' },
      { num: '29', name: 'GP29', kind: 'gpio' },
      { num: '28', name: 'GP28', kind: 'gpio' },
      { num: '27', name: 'GP27', kind: 'gpio' },
      { num: '26', name: 'GP26', kind: 'gpio' },
      { num: '15', name: 'GP15', kind: 'gpio' },
      { num: '14', name: 'GP14', kind: 'gpio' },
    ],
    bottom: [
      { num: '13', name: 'GP13', kind: 'gpio' },
      { num: '12', name: 'GP12', kind: 'gpio' },
      { num: '11', name: 'GP11', kind: 'gpio' },
      { num: '10', name: 'GP10', kind: 'gpio' },
      { num: '9', name: 'GP9', kind: 'gpio' },
    ],
    right: [
      { num: '0', name: 'GP0', kind: 'gpio' },
      { num: '1', name: 'GP1', kind: 'gpio' },
      { num: '2', name: 'GP2', kind: 'gpio' },
      { num: '3', name: 'GP3', kind: 'gpio' },
      { num: '4', name: 'GP4', kind: 'gpio' },
      { num: '5', name: 'GP5', kind: 'gpio' },
      { num: '6', name: 'GP6', kind: 'gpio' },
      { num: '7', name: 'GP7', kind: 'gpio' },
      { num: '8', name: 'GP8', kind: 'gpio' },
    ],
  },
};

// Ready-made starting points that match popular boards built with these PCBs.
// Every preset is one side of a symmetric split.
const PRESETS = [
  {
    id: 'default',
    name: 'Crustrusk default · 3×7 + 3 + knob',
    columns: {
      col0: 'col3',
      col1: 'col3',
      col2: 'col3',
      col3: 'col3',
      col4: 'col3',
      col5: 'col3',
      col6: 'col3',
      col7: 'thumb3-corne',
    },
    peripheral: 'ec11',
  },
  {
    id: 'corne',
    name: 'Corne · 3×6 + 3',
    columns: {
      col0: 'col3',
      col1: 'col3',
      col2: 'col3',
      col3: 'col3',
      col4: 'col3',
      col5: 'col3',
      col6: 'thumb3-corne',
    },
    peripheral: null,
  },
  {
    id: 'lily58',
    name: 'Lily58-style · 4×6 + 4',
    columns: {
      col0: 'col4',
      col1: 'col4',
      col2: 'col4',
      col3: 'col4',
      col4: 'col4',
      col5: 'col4',
      col6: 'thumb4-lily58',
    },
    peripheral: 'ec11',
  },
  {
    id: 'sofle',
    name: 'Sofle-style · 4×6 + 5 + knob',
    columns: {
      col0: 'col4',
      col1: 'col4',
      col2: 'col4',
      col3: 'col4',
      col4: 'col4',
      col5: 'col4',
      col6: 'thumb5-sofle',
    },
    peripheral: 'ec11',
  },
  {
    id: 'sweep',
    name: 'Sweep-style · 3×5 + 2',
    columns: {
      col0: 'col3',
      col1: 'col3',
      col2: 'col3',
      col3: 'col3',
      col4: 'col3',
      col5: 'thumb2-sweep',
    },
    peripheral: null,
  },
  {
    id: 'asym',
    name: 'Asymmetric pinky · Corne + Lily58',
    columns: {
      col0: 'asym-col-corne',
      col1: 'col4',
      col2: 'col4',
      col3: 'col4',
      col4: 'col4',
      col5: 'col4',
      col6: 'thumb4-lily58',
    },
    peripheral: null,
  },
];
