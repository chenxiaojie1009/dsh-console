/**
 * Switch vendor registry.
 *
 * Each vendor carries (a) passive detection hints used on device echo, and
 * (b) the vendor's own command syntax for the operations the panel and the
 * model are allowed to suggest. Commands are deliberately limited to the
 * syntax families we can state confidently, so the model never has to mix
 * vendor grammars.
 */

/** A vendor row. */
export const VENDORS = [
  {
    id: 'huawei',
    label: '华为 Huawei (VRP)',
    short: '华为',
    detect: { keywords: ['huawei', 'vrp', 'quidway', 'cloudengine', 's5700', 's6700', 's12700', 'ne40'] },
    commands: {
      version: 'display version',
      interfaces: 'display interface brief',
      macTable: 'display mac-address',
      ipInterfaces: 'display ip interface brief',
      routes: 'display ip routing-table',
      runningConfig: 'display current-configuration',
      save: 'save',
    },
  },
  {
    id: 'h3c',
    label: 'H3C 新华三 (Comware)',
    short: 'H3C',
    detect: { keywords: ['h3c', 'comware', 'h3c technologies'] },
    commands: {
      version: 'display version',
      interfaces: 'display interface brief',
      macTable: 'display mac-address',
      ipInterfaces: 'display ip interface brief',
      routes: 'display ip routing-table',
      runningConfig: 'display current-configuration',
      save: 'save',
    },
  },
  {
    id: 'cisco',
    label: '思科 Cisco (IOS/NX-OS)',
    short: '思科',
    detect: { keywords: ['cisco ios', 'ios software', 'ios xe', 'nx-os', 'cisco systems', 'catalyst'] },
    commands: {
      version: 'show version',
      interfaces: 'show ip interface brief',
      macTable: 'show mac address-table',
      ipInterfaces: 'show ip interface brief',
      routes: 'show ip route',
      runningConfig: 'show running-config',
      save: 'write memory',
    },
  },
  {
    id: 'ruijie',
    label: '锐捷 Ruijie (RGOS)',
    short: '锐捷',
    detect: { keywords: ['ruijie', 'rgos', '锐捷'] },
    commands: {
      version: 'show version',
      interfaces: 'show interfaces status',
      macTable: 'show mac-address-table',
      ipInterfaces: 'show ip interface brief',
      routes: 'show ip route',
      runningConfig: 'show running-config',
      save: 'write memory',
    },
  },
  {
    id: 'tplink',
    label: 'TP-Link (JetStream)',
    short: 'TP-Link',
    detect: { keywords: ['tp-link', 'tplink', 'jetstream'] },
    commands: {
      version: 'show version',
      interfaces: 'show interface status',
      macTable: 'show mac address-table',
      ipInterfaces: 'show ip interface',
      routes: 'show ip route',
      runningConfig: 'show running-config',
      save: 'copy running-config startup-config',
    },
  },
  {
    id: 'juniper',
    label: 'Juniper (Junos)',
    short: 'Juniper',
    detect: { keywords: ['juniper', 'junos'] },
    commands: {
      version: 'show version',
      interfaces: 'show interfaces terse',
      macTable: 'show ethernet-switching table',
      ipInterfaces: 'show interfaces terse',
      routes: 'show route',
      runningConfig: 'show configuration',
      save: 'commit',
    },
  },
  {
    id: 'mikrotik',
    label: 'MikroTik (RouterOS)',
    short: 'MikroTik',
    detect: { keywords: ['mikrotik', 'routeros'] },
    commands: {
      version: '/system resource print',
      interfaces: '/interface print',
      macTable: '/interface bridge host print',
      ipInterfaces: '/ip address print',
      routes: '/ip route print',
      runningConfig: '/export',
      save: '/system backup save',
    },
  },
]

/** The pseudo vendor shown while nothing is selected or detected. */
export const UNKNOWN_VENDOR = { id: 'unknown', label: '未识别（请选择厂商）', short: '未识别' }

/** Reference labels for the panel's command card. */
const REFERENCE = [
  { key: 'version', label: '查看版本/型号' },
  { key: 'interfaces', label: '查看接口状态' },
  { key: 'macTable', label: '查看 MAC 地址表' },
  { key: 'ipInterfaces', label: '查看接口 IP' },
  { key: 'routes', label: '查看路由表' },
  { key: 'runningConfig', label: '查看当前配置' },
  { key: 'save', label: '保存配置' },
]

/**
 * Look one vendor up by id.
 * @param {string|undefined|null} id vendor id.
 * @returns {object|undefined} the vendor row.
 */
export function vendorById(id) {
  if (typeof id !== 'string' || id === '') return undefined
  return VENDORS.find(vendor => vendor.id === id)
}

/**
 * Minimal vendor list for selectors.
 * @returns {Array<{id:string,label:string,short:string}>} selectable vendors.
 */
export function listVendors() {
  return VENDORS.map(vendor => ({ id: vendor.id, label: vendor.label, short: vendor.short }))
}

/**
 * The vendor's command reference for the panel card.
 * @param {string|undefined|null} id vendor id.
 * @returns {Array<{key:string,label:string,command:string}>} command rows.
 */
export function vendorReference(id) {
  const vendor = vendorById(id)
  if (vendor === undefined) return []
  return REFERENCE.filter(row => typeof vendor.commands[row.key] === 'string').map(row => ({
    key: row.key,
    label: row.label,
    command: vendor.commands[row.key],
  }))
}

/**
 * Detect the vendor from device echo (banners, version output, prompt hints).
 * @param {string} text device transcript text.
 * @returns {{id:string,label:string,score:number}|undefined} best match, or undefined.
 */
export function detectVendor(text) {
  const haystack = String(text ?? '').toLowerCase()
  if (haystack === '') return undefined
  let best
  let tied = false
  for (const vendor of VENDORS) {
    let score = 0
    for (const keyword of vendor.detect.keywords) {
      if (keyword !== '' && haystack.includes(keyword.toLowerCase())) score += 1
    }
    if (score === 0) continue
    if (best === undefined || score > best.score) {
      best = { id: vendor.id, label: vendor.label, score }
      tied = false
    } else if (score === best.score) {
      tied = true
    }
  }
  if (best === undefined || tied) return undefined
  return best
}
