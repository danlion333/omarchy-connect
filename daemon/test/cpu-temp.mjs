/**
 * Which sensor the Load card's temperature comes from.
 *
 * The phone showed 28 °C on every reading, on a desktop whose cores sat in the
 * fifties. Not a stale value and not a unit mistake: `/sys/class/thermal` on
 * that machine exposes `acpitz` — the board's ambient probe, which really is
 * about 28 °C — as thermal_zone0, and the old reader took the first zone whose
 * type matched any of its patterns. Room temperature, forever.
 *
 * So the sensors are stood in for by a fixture tree, and what is tested is the
 * choosing: a package sensor beats the ambient probe whatever order they are
 * read in, hwmon is consulted when the thermal zones carry nothing better, a
 * whole-package label beats a single core, and a machine with no CPU sensor at
 * all says `null` rather than handing the card a number off the wrong chip.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { cpuTemp } from '../src/lib/sys.js'
import { check, done } from '../../tools/test-harness.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-cputemp-'))
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }))

/** One fixture tree per case, so no case can be read out of another's leftovers. */
let serial = 0
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${text}\n`)
}

/**
 * `zones` are `[type, millidegrees]`; `hwmons` are `[name, [[label, milli], …]]`
 * with a null label standing for a sensor the driver does not name.
 */
const sysfs = ({ zones = [], hwmons = [] }) => {
  const dir = path.join(root, `case${serial++}`)
  zones.forEach(([type, milli], i) => {
    write(path.join(dir, 'thermal', `thermal_zone${i}`, 'type'), type)
    write(path.join(dir, 'thermal', `thermal_zone${i}`, 'temp'), String(milli))
  })
  hwmons.forEach(([name, sensors], i) => {
    const node = path.join(dir, 'hwmon', `hwmon${i}`)
    write(path.join(node, 'name'), name)
    sensors.forEach(([label, milli], j) => {
      write(path.join(node, `temp${j + 1}_input`), String(milli))
      if (label !== null) write(path.join(node, `temp${j + 1}_label`), label)
    })
  })
  return dir
}

/* ── the bug ────────────────────────────────────────────────────────────── */

check(
  'the package sensor wins over the ambient probe listed before it',
  cpuTemp(sysfs({ zones: [['acpitz', 27800], ['x86_pkg_temp', 52000]] })) === 52,
  `${cpuTemp(sysfs({ zones: [['acpitz', 27800], ['x86_pkg_temp', 52000]] }))}°C`,
)
check(
  'and over one listed after it',
  cpuTemp(sysfs({ zones: [['x86_pkg_temp', 52000], ['acpitz', 27800]] })) === 52,
)
check(
  'an AMD box with only acpitz in the zones reads its k10temp from hwmon',
  cpuTemp(sysfs({ zones: [['acpitz', 28000]], hwmons: [['k10temp', [['Tctl', 61000]]]] })) === 61,
)
check(
  'the ambient probe is still used when it is the only sensor there is',
  cpuTemp(sysfs({ zones: [['acpitz', 27800]] })) === 28,
)

/* ── choosing within a chip ─────────────────────────────────────────────── */

check(
  'the whole package beats any single core',
  cpuTemp(sysfs({ hwmons: [['coretemp', [['Package id 0', 52000], ['Core 0', 58000]]]] })) === 52,
)
check(
  'an unlabelled coretemp sensor is still better than nothing',
  cpuTemp(sysfs({ zones: [['acpitz', 28000]], hwmons: [['coretemp', [[null, 55000]]]] })) === 55,
)
check(
  'a GPU and an SSD are not the CPU',
  cpuTemp(sysfs({ hwmons: [['amdgpu', [['edge', 71000]]], ['nvme', [['Composite', 44000]]]] })) === null,
)
check('nor is a network card that happens to run hot', cpuTemp(sysfs({ hwmons: [['r8169_0_800:00', [[null, 68000]]]] })) === null)

/* ── nothing to read ────────────────────────────────────────────────────── */

check('a machine with no sensors at all says null', cpuTemp(sysfs({})) === null)
check('so does one whose sysfs is not there', cpuTemp(path.join(root, 'nosuchtree')) === null)
check(
  'a sensor reading below freezing or past a shutdown trip is not believed',
  cpuTemp(sysfs({ zones: [['x86_pkg_temp', 0], ['coretemp', 250000]] })) === null,
)
check('a value is rounded, not truncated', cpuTemp(sysfs({ zones: [['x86_pkg_temp', 52600]] })) === 53)

done('CPU temperature checks')
