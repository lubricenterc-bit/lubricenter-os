/**
 * Gotín: la gota de Lubricenter en estilo rubberhose, y sus piezas de marca.
 * Se generan como SVG en texto (contenido fijo, sin datos del usuario) para que
 * cada parte se pueda animar con CSS usando solo transform y opacity.
 */

export type GotinPose = "wave" | "hold" | "can" | "clip" | "flag" | "point" | "cheer" | "shrug" | "idle";
export type GotinOptions = { label?: string; className?: string; decorative?: boolean };
type GotinProp = "wrench" | "can" | "clip" | "flag";
type ArmPose = "down" | "up" | "out" | "hip" | "hold" | "front";
type ArmSpec = { d: string; gx: number; gy: number; ga: number };
type PoseSpec = { l: ArmPose; r: ArmPose; lh?: "point"; rh?: "point"; lp?: GotinProp; rp?: GotinProp };

const K = "#161616", O = "#FF5D15", W = "#FFFFFF", SW = 5;

function escapeAttr(value: string) {
  return value.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c] as string);
}

// Guante abierto, apuntando hacia arriba, con la muñeca en (0,0)
function glove(): string {
  return '<g class="glove">'+
    '<rect x="-10" y="-34" width="7.5" height="20" rx="3.75" fill="'+W+'" stroke="'+K+'" stroke-width="3.2"/>'+
    '<rect x="-3.6" y="-37" width="7.5" height="22" rx="3.75" fill="'+W+'" stroke="'+K+'" stroke-width="3.2"/>'+
    '<rect x="3" y="-33" width="7.5" height="19" rx="3.75" fill="'+W+'" stroke="'+K+'" stroke-width="3.2"/>'+
    '<rect x="-19" y="-22" width="14" height="7.5" rx="3.75" transform="rotate(-28 -12 -18)" fill="'+W+'" stroke="'+K+'" stroke-width="3.2"/>'+
    '<path d="M-11 -20 C-12 -10 -8 -3 0 -3 C8 -3 12 -10 11 -20 Z" fill="'+W+'" stroke="'+K+'" stroke-width="3.2" stroke-linejoin="round"/>'+
    '<path d="M-10.5 -4 Q0 2 10.5 -4 L10 4 Q0 9 -10 4 Z" fill="'+W+'" stroke="'+K+'" stroke-width="3.2" stroke-linejoin="round"/>'+
  '</g>';
}
// Guante señalando con el índice
function pointer(): string {
  return '<g class="glove">'+
    '<rect x="-3.8" y="-44" width="7.6" height="30" rx="3.8" fill="'+W+'" stroke="'+K+'" stroke-width="3.2"/>'+
    '<path d="M-12 -20 C-13 -10 -8 -3 0 -3 C8 -3 13 -10 12 -20 C12 -26 6 -27 4 -22 L-4 -22 C-7 -27 -12 -26 -12 -20 Z" fill="'+W+'" stroke="'+K+'" stroke-width="3.2" stroke-linejoin="round"/>'+
    '<path d="M-7 -16 L-7 -12 M0 -17 L0 -12 M6 -16 L6 -12" stroke="'+K+'" stroke-width="2.4" stroke-linecap="round"/>'+
    '<path d="M-10.5 -4 Q0 2 10.5 -4 L10 4 Q0 9 -10 4 Z" fill="'+W+'" stroke="'+K+'" stroke-width="3.2" stroke-linejoin="round"/>'+
  '</g>';
}
// Accesorios, dibujados con la mano en (0,0)
const PROPS: Record<GotinProp, string> = {
  wrench:'<g class="prop"><rect x="-4.5" y="-78" width="9" height="62" rx="4.5" fill="'+W+'" stroke="'+K+'" stroke-width="3.6"/>'+
    '<path d="M-15 -84 C-17 -98 -8 -106 0 -106 L0 -95 L8 -95 L8 -106 C16 -104 20 -95 16 -85 C13 -78 6 -76 0 -77 C-7 -77 -13 -79 -15 -84 Z" fill="'+W+'" stroke="'+K+'" stroke-width="3.6" stroke-linejoin="round"/>'+
    '<circle cx="0" cy="-34" r="2.6" fill="'+K+'"/></g>',
  can:'<g class="prop" transform="translate(-12 6)"><path d="M-20 -14 L20 -14 L18 -44 L-18 -44 Z" fill="'+O+'" stroke="'+K+'" stroke-width="3.6" stroke-linejoin="round"/>'+
    '<path d="M-14 -44 L-6 -58 L6 -58 L14 -44 Z" fill="'+W+'" stroke="'+K+'" stroke-width="3.6" stroke-linejoin="round"/>'+
    '<path d="M16 -34 L46 -62" stroke="'+K+'" stroke-width="5" stroke-linecap="round"/>'+
    '<path d="M-6 -60 L6 -60" stroke="'+K+'" stroke-width="4" stroke-linecap="round"/>'+
    '<text x="0" y="-23" text-anchor="middle" font-family="Switzer,Arial,sans-serif" font-weight="800" font-size="13" fill="'+K+'">LC</text>'+
    '<path class="drip" d="M47 -56 C44 -50 44 -47 47 -45 C50 -47 50 -50 47 -56 Z" fill="'+O+'" stroke="'+K+'" stroke-width="2"/></g>',
  clip:'<g class="prop"><rect x="-17" y="-60" width="34" height="44" rx="4" fill="'+W+'" stroke="'+K+'" stroke-width="3.6"/>'+
    '<rect x="-8" y="-65" width="16" height="9" rx="2.5" fill="'+O+'" stroke="'+K+'" stroke-width="3.2"/>'+
    '<path d="M-10 -46 L10 -46 M-10 -38 L10 -38 M-10 -30 L3 -30" stroke="'+K+'" stroke-width="2.6" stroke-linecap="round"/></g>',
  flag:'<g class="prop"><path d="M0 -14 L0 -96" stroke="'+K+'" stroke-width="4.5" stroke-linecap="round"/>'+
    '<g class="cloth"><path d="M0 -94 C14 -100 26 -88 42 -94 L42 -66 C26 -60 14 -72 0 -66 Z" fill="'+W+'" stroke="'+K+'" stroke-width="3.6" stroke-linejoin="round"/>'+
    '<path d="M0 -94 L10 -96 L10 -86 L0 -85 Z M20 -93 L30 -91 L30 -82 L20 -84 Z M10 -86 L20 -84 L20 -75 L10 -76 Z M30 -82 L42 -84 L42 -75 L30 -73 Z M0 -76 L10 -76 L10 -67 L0 -66 Z M20 -75 L30 -73 L30 -64 L20 -66 Z" fill="'+K+'"/></g></g>'
};
// Brazos: trazo de manguera desde el hombro, con el guante orientado al final
const ARMS: Record<ArmPose, ArmSpec> = {
  down:{d:'M166 160 C184 168 190 186 184 204',gx:184,gy:206,ga:165},
  up:{d:'M166 156 C188 148 196 124 190 100',gx:190,gy:98,ga:-12},
  out:{d:'M166 160 C178 158 188 154 196 150',gx:196,gy:150,ga:68},
  hip:{d:'M166 162 C182 166 184 178 164 183',gx:161,gy:183,ga:-110},
  hold:{d:'M166 158 C186 156 194 136 190 118',gx:190,gy:116,ga:0},
  front:{d:'M166 162 C178 172 176 188 160 192',gx:160,gy:192,ga:-100}
};
function arm(side: "l" | "r", k: ArmPose, hand?: "point", prop?: GotinProp): string {
  const a = ARMS[k];
  const g ='<path d="'+a.d+'" fill="none" stroke="'+K+'" stroke-width="'+SW+'" stroke-linecap="round"/>'+
    '<g transform="translate('+a.gx+' '+a.gy+') rotate('+a.ga+')">'+(prop?'<g transform="rotate('+(-a.ga)+')">'+PROPS[prop]+'</g>':'')+(hand==='point'?pointer():glove())+'</g>';
  return '<g class="arm arm-'+side+' arm-'+k+'"'+(side==='l'?' transform="translate(220 0) scale(-1 1)"':'')+'><g class="arm-in">'+g+'</g></g>';
}
const POSES: Record<GotinPose, PoseSpec> = {
  wave:{l:'hip',r:'up'},
  hold:{l:'hip',r:'hold',rp:'wrench'},
  can:{l:'hip',r:'hold',rp:'can'},
  clip:{l:'down',r:'hold',rp:'clip'},
  flag:{l:'hip',r:'hold',rp:'flag'},
  point:{l:'hip',r:'out',rh:'point'},
  cheer:{l:'up',r:'up'},
  shrug:{l:'out',r:'out'},
  idle:{l:'down',r:'down'}
};
export function gotinSvg(pose: GotinPose, opt: GotinOptions = {}): string {
  const p = POSES[pose] ?? POSES.idle;
  return '<svg class="gotin pose-'+pose+(opt.className?' '+opt.className:'')+'" viewBox="-18 -8 256 264" '+(opt.decorative?'aria-hidden="true"':'role="img" aria-label="'+escapeAttr(opt.label||'Gotín, la gota de Lubricenter')+'"')+'>'+
    '<ellipse class="shadow" cx="110" cy="244" rx="46" ry="5.5" fill="'+K+'" opacity=".14"/>'+
    '<g class="bob">'+
      '<g class="legs" stroke="'+K+'" stroke-width="'+SW+'" stroke-linecap="round" fill="none">'+
        '<path class="leg-l" d="M96 206 C96 218 93 225 89 231"/><path class="leg-r" d="M124 206 C124 218 127 225 131 231"/></g>'+
      '<g class="shoes"><ellipse cx="80" cy="234" rx="17" ry="8.5" fill="'+K+'"/><ellipse cx="140" cy="234" rx="17" ry="8.5" fill="'+K+'"/>'+
        '<ellipse cx="74" cy="231" rx="5" ry="2" fill="'+W+'" opacity=".55"/><ellipse cx="134" cy="231" rx="5" ry="2" fill="'+W+'" opacity=".55"/></g>'+
      arm('l',p.l,p.lh,p.lp)+
      '<g class="body">'+
        '<path d="M110 20 C128 56 170 96 170 150 A60 60 0 0 1 50 150 C50 96 92 56 110 20 Z" fill="'+O+'" stroke="'+K+'" stroke-width="'+SW+'" stroke-linejoin="round"/>'+
        '<path d="M73 112 C66 128 66 144 71 160" fill="none" stroke="'+W+'" stroke-width="8" stroke-linecap="round" opacity=".9"/>'+
        '<circle cx="80" cy="99" r="4.5" fill="'+W+'" opacity=".9"/>'+
        '<g class="eyes">'+
          '<g class="eye"><ellipse cx="94" cy="128" rx="8.5" ry="13.5" fill="'+K+'"/><path d="M94 128 L98.3 116.3 A8.5 13.5 0 0 1 101.9 123 Z" fill="'+W+'"/></g>'+
          '<g class="eye"><ellipse cx="126" cy="128" rx="8.5" ry="13.5" fill="'+K+'"/><path d="M126 128 L130.3 116.3 A8.5 13.5 0 0 1 133.9 123 Z" fill="'+W+'"/></g>'+
        '</g>'+
        '<path class="mouth" d="M88 157 C94 177 126 177 132 157 C120 163 100 163 88 157 Z" fill="'+K+'" stroke="'+K+'" stroke-width="2.5" stroke-linejoin="round"/>'+
        '<path d="M101 169 C105 164 115 164 119 169 C114 172.5 106 172.5 101 169 Z" fill="#FF9466"/>'+
      '</g>'+
      arm('r',p.r,p.rh,p.rp)+
    '</g></svg>';
}

// ---------- Piezas de marca: objetos del taller con la misma línea de Gotín ----------

function svg(vb: string, body: string, cls?: string): string {
  return '<svg class="bi '+(cls||'')+'" viewBox="'+vb+'" aria-hidden="true">'+body+'</svg>';
}
export const BRAND_ICONS = {
  can: (c?: string): string => svg('0 0 120 120',
    '<g class="can-body"><path d="M58 30 C70 26 98 6 112 2" stroke="'+K+'" stroke-width="6" stroke-linecap="round" fill="none"/>'+
    '<path d="M22 56 C14 56 10 64 12 74 C14 82 20 84 26 82" fill="none" stroke="'+K+'" stroke-width="5" stroke-linecap="round"/>'+
    '<path d="M24 104 L94 104 L88 58 L30 58 Z" fill="'+W+'" stroke="'+K+'" stroke-width="5" stroke-linejoin="round"/>'+
    '<path class="dome" d="M34 58 C36 40 48 30 59 30 C70 30 82 40 84 58 Z" fill="'+O+'" stroke="'+K+'" stroke-width="5" stroke-linejoin="round"/>'+
    '<path d="M40 78 L78 78" stroke="'+K+'" stroke-width="4" stroke-linecap="round"/><path d="M44 90 L70 90" stroke="'+K+'" stroke-width="4" stroke-linecap="round"/></g>'+
    '<path class="drop" d="M112 8 C107 16 106 20 109 23 C112 26 116 23 116 19 C116 15 113 11 112 8 Z" fill="'+O+'" stroke="'+K+'" stroke-width="2.6"/>',c),
  car: (c?: string): string => svg('0 0 124 92',
    '<g class="car-body"><path d="M10 60 Q10 45 26 42 L40 24 Q45 18 55 18 L80 18 Q90 18 96 27 L104 42 Q116 44 116 56 L116 62 Q116 67 111 67 L15 67 Q10 67 10 62 Z" fill="'+O+'" stroke="'+K+'" stroke-width="4.5" stroke-linejoin="round"/>'+
    '<path d="M45 41 L53 28 Q55 25 59 25 L68 25 L68 41 Z M75 25 L83 25 Q87 25 89 29 L95 41 L75 41 Z" fill="'+W+'" stroke="'+K+'" stroke-width="3.5" stroke-linejoin="round"/>'+
    '<circle cx="110" cy="52" r="3.5" fill="'+W+'" stroke="'+K+'" stroke-width="2.5"/></g>'+
    '<g class="wheel" style="transform-origin:34px 68px"><circle cx="34" cy="68" r="12" fill="'+K+'"/><circle cx="34" cy="68" r="4.5" fill="'+W+'"/><path d="M34 58 L34 62" stroke="'+W+'" stroke-width="2.4" stroke-linecap="round"/></g>'+
    '<g class="wheel" style="transform-origin:90px 68px"><circle cx="90" cy="68" r="12" fill="'+K+'"/><circle cx="90" cy="68" r="4.5" fill="'+W+'"/><path d="M90 58 L90 62" stroke="'+W+'" stroke-width="2.4" stroke-linecap="round"/></g>'+
    '<path class="speed" d="M2 36 L-14 36 M4 48 L-20 48 M2 60 L-10 60" stroke="'+K+'" stroke-width="3.5" stroke-linecap="round"/>',c),
  clip: (c?: string): string => svg('0 0 120 120',
    '<rect x="22" y="16" width="64" height="88" rx="8" fill="'+W+'" stroke="'+K+'" stroke-width="5"/>'+
    '<rect x="38" y="8" width="32" height="16" rx="5" fill="'+O+'" stroke="'+K+'" stroke-width="4.5"/>'+
    '<path class="ln ln1" d="M34 44 L74 44" stroke="'+K+'" stroke-width="4.5" stroke-linecap="round"/>'+
    '<path class="ln ln2" d="M34 60 L74 60" stroke="'+K+'" stroke-width="4.5" stroke-linecap="round"/>'+
    '<path class="ln ln3" d="M34 76 L60 76" stroke="'+K+'" stroke-width="4.5" stroke-linecap="round"/>'+
    '<g class="pencil"><path d="M78 92 L106 38 L116 43 L88 97 L76 104 Z" fill="'+O+'" stroke="'+K+'" stroke-width="4.5" stroke-linejoin="round"/><path d="M80 100 L76 104 L77 98" fill="'+K+'"/></g>',c),
  wrench: (c?: string): string => svg('0 0 120 120',
    '<g class="wr"><path d="M52 64 L22 94 Q16 100 22 106 Q28 112 34 106 L64 76 Z" fill="'+W+'" stroke="'+K+'" stroke-width="5" stroke-linejoin="round"/>'+
    '<path d="M56 46 C50 30 62 12 82 14 L70 28 L74 42 L88 46 L102 34 C106 52 90 68 72 62 L64 76 L52 64 Z" fill="'+W+'" stroke="'+K+'" stroke-width="5" stroke-linejoin="round"/>'+
    '<circle cx="27" cy="101" r="3" fill="'+K+'"/></g>'+
    '<g class="bolt"><path d="M92 82 L104 82 L110 92 L104 102 L92 102 L86 92 Z" fill="'+O+'" stroke="'+K+'" stroke-width="4.5" stroke-linejoin="round"/><circle cx="98" cy="92" r="3.5" fill="'+W+'" stroke="'+K+'" stroke-width="2.5"/></g>',c),
  lens: (c?: string): string => svg('0 0 120 120',
    '<g class="lens"><path d="M70 70 L100 100" stroke="'+K+'" stroke-width="15" stroke-linecap="round"/><path d="M82 82 L100 100" stroke="'+O+'" stroke-width="8" stroke-linecap="round"/>'+
    '<circle cx="50" cy="50" r="30" fill="'+W+'" stroke="'+K+'" stroke-width="5"/>'+
    '<path d="M34 40 Q38 30 48 28" fill="none" stroke="'+K+'" stroke-width="4" stroke-linecap="round" opacity=".35"/></g>',c),
  hourglass: (c?: string): string => svg('0 0 120 120',
    '<g class="hg" style="transform-origin:60px 60px"><rect x="26" y="10" width="68" height="12" rx="5" fill="'+K+'"/><rect x="26" y="98" width="68" height="12" rx="5" fill="'+K+'"/>'+
    '<path d="M34 22 L86 22 C86 44 66 52 66 60 C66 68 86 76 86 98 L34 98 C34 76 54 68 54 60 C54 52 34 44 34 22 Z" fill="'+W+'" stroke="'+K+'" stroke-width="5" stroke-linejoin="round"/>'+
    '<path d="M44 34 L76 34 C72 44 62 48 60 52 C58 48 48 44 44 34 Z" fill="'+O+'"/><path d="M42 92 C46 80 56 76 60 74 C64 76 74 80 78 92 Z" fill="'+O+'"/>'+
    '<path class="sand" d="M60 56 L60 74" stroke="'+O+'" stroke-width="3" stroke-dasharray="3 4"/></g>',c),
  flag: (c?: string): string => svg('0 0 120 120',
    '<path d="M28 112 L28 12" stroke="'+K+'" stroke-width="6" stroke-linecap="round"/>'+
    '<g class="cloth" style="transform-origin:28px 40px"><path d="M30 14 C50 6 66 22 94 14 L94 58 C66 66 50 50 30 58 Z" fill="'+W+'" stroke="'+K+'" stroke-width="5" stroke-linejoin="round"/>'+
    '<path d="M30 14 L46 12 L46 26 L30 28 Z M62 14 L78 16 L78 30 L62 28 Z M46 26 L62 28 L62 42 L46 40 Z M78 30 L94 28 L94 42 L78 44 Z M30 42 L46 40 L46 54 L30 57 Z M62 42 L78 44 L78 58 L62 56 Z" fill="'+K+'"/></g>',c),
  clock: (c?: string): string => svg('0 0 120 120',
    '<g class="ring" style="transform-origin:60px 64px"><path d="M30 34 A16 16 0 0 1 48 18 Z" fill="'+O+'" stroke="'+K+'" stroke-width="4.5" stroke-linejoin="round"/><path d="M90 34 A16 16 0 0 0 72 18 Z" fill="'+O+'" stroke="'+K+'" stroke-width="4.5" stroke-linejoin="round"/>'+
    '<path d="M38 100 L30 110 M82 100 L90 110" stroke="'+K+'" stroke-width="5" stroke-linecap="round"/>'+
    '<circle cx="60" cy="64" r="38" fill="'+W+'" stroke="'+K+'" stroke-width="5"/>'+
    '<path d="M60 64 L60 40 M60 64 L76 72" stroke="'+K+'" stroke-width="5" stroke-linecap="round"/><circle cx="60" cy="64" r="4" fill="'+O+'" stroke="'+K+'" stroke-width="2"/></g>',c),
  tag: (c?: string): string => svg('0 0 120 120',
    '<g class="tagb" style="transform-origin:96px 22px"><path d="M58 14 L100 14 Q106 14 106 20 L106 62 L56 112 Q52 116 48 112 L8 72 Q4 68 8 64 Z" fill="'+O+'" stroke="'+K+'" stroke-width="5" stroke-linejoin="round"/>'+
    '<circle cx="86" cy="34" r="8" fill="'+W+'" stroke="'+K+'" stroke-width="4.5"/><path d="M38 72 L60 50 M46 80 L68 58 M54 88 L66 76" stroke="'+K+'" stroke-width="4.5" stroke-linecap="round"/></g>',c),
  cal: (c?: string): string => svg('0 0 120 120',
    '<rect x="14" y="22" width="92" height="84" rx="10" fill="'+W+'" stroke="'+K+'" stroke-width="5"/>'+
    '<path d="M14 46 L106 46 L106 32 Q106 22 96 22 L24 22 Q14 22 14 32 Z" fill="'+O+'" stroke="'+K+'" stroke-width="5" stroke-linejoin="round"/>'+
    '<path d="M38 12 L38 30 M82 12 L82 30" stroke="'+K+'" stroke-width="6" stroke-linecap="round"/>'+
    '<circle cx="40" cy="66" r="4.5" fill="'+K+'"/><circle cx="60" cy="66" r="4.5" fill="'+K+'"/><circle cx="80" cy="66" r="4.5" fill="'+K+'"/><circle cx="40" cy="86" r="4.5" fill="'+K+'"/>'+
    '<circle class="today" cx="60" cy="86" r="8" fill="'+O+'" stroke="'+K+'" stroke-width="3.5"/>',c),
  bottle: (c?: string): string => svg('0 0 120 120',
    '<path d="M44 10 L66 10 L66 22 L44 22 Z" fill="'+K+'"/><path d="M40 22 L70 22 L70 30 Q86 34 86 50 L86 104 Q86 110 80 110 L30 110 Q24 110 24 104 L24 40 Q24 30 40 30 Z" fill="'+O+'" stroke="'+K+'" stroke-width="5" stroke-linejoin="round"/>'+
    '<rect x="32" y="54" width="46" height="32" rx="4" fill="'+W+'" stroke="'+K+'" stroke-width="4"/><path d="M40 66 L70 66 M40 76 L60 76" stroke="'+K+'" stroke-width="3.5" stroke-linecap="round"/>'+
    '<path d="M32 44 Q32 36 40 36" fill="none" stroke="'+W+'" stroke-width="4" stroke-linecap="round" opacity=".8"/>',c),
  filter: (c?: string): string => svg('0 0 120 120',
    '<path d="M24 34 L24 96 Q24 108 60 108 Q96 108 96 96 L96 34" fill="'+O+'" stroke="'+K+'" stroke-width="5" stroke-linejoin="round"/>'+
    '<path d="M36 44 L36 100 M48 46 L48 104 M60 46 L60 106 M72 46 L72 104 M84 44 L84 100" stroke="'+K+'" stroke-width="3" opacity=".5"/>'+
    '<ellipse cx="60" cy="34" rx="36" ry="12" fill="'+W+'" stroke="'+K+'" stroke-width="5"/><ellipse cx="60" cy="34" rx="12" ry="4.5" fill="'+K+'"/>',c),
  spray: (c?: string): string => svg('0 0 120 120',
    '<rect x="34" y="40" width="48" height="70" rx="10" fill="'+W+'" stroke="'+K+'" stroke-width="5"/><path d="M34 58 L82 58 L82 82 L34 82 Z" fill="'+O+'" stroke="'+K+'" stroke-width="4"/>'+
    '<rect x="46" y="22" width="24" height="18" rx="4" fill="'+K+'"/><path d="M70 28 L84 24" stroke="'+K+'" stroke-width="5" stroke-linecap="round"/>'+
    '<circle class="puffs" cx="96" cy="20" r="4" fill="'+O+'"/><circle class="puffs" cx="104" cy="28" r="3" fill="'+O+'"/><circle class="puffs" cx="100" cy="12" r="2.5" fill="'+O+'"/>',c),
  glove: (c?: string): string => svg('-30 -50 60 60',
    '<rect x="-3.8" y="-44" width="7.6" height="30" rx="3.8" fill="'+W+'" stroke="'+K+'" stroke-width="3.2"/>'+
    '<path d="M-12 -20 C-13 -10 -8 -3 0 -3 C8 -3 13 -10 12 -20 C12 -26 6 -27 4 -22 L-4 -22 C-7 -27 -12 -26 -12 -20 Z" fill="'+W+'" stroke="'+K+'" stroke-width="3.2" stroke-linejoin="round"/>'+
    '<path d="M-7 -16 L-7 -12 M0 -17 L0 -12 M6 -16 L6 -12" stroke="'+K+'" stroke-width="2.4" stroke-linecap="round"/>'+
    '<path d="M-10.5 -4 Q0 2 10.5 -4 L10 4 Q0 9 -10 4 Z" fill="'+W+'" stroke="'+K+'" stroke-width="3.2" stroke-linejoin="round"/>',c),
  puff: (c?: string): string => svg('0 0 120 80',
    '<circle cx="34" cy="48" r="20" fill="'+W+'" stroke="'+K+'" stroke-width="4"/><circle cx="62" cy="34" r="24" fill="'+W+'" stroke="'+K+'" stroke-width="4"/><circle cx="88" cy="50" r="18" fill="'+W+'" stroke="'+K+'" stroke-width="4"/>'+
    '<path d="M30 52 Q60 70 90 54" fill="'+W+'"/>',c),
  star: (c?: string, col?: string): string => svg('-20 -20 40 40','<path d="M0 -18 C2 -6 6 -2 18 0 C6 2 2 6 0 18 C-2 6 -6 2 -18 0 C-6 -2 -2 -6 0 -18 Z" fill="'+(col||O)+'" stroke="'+K+'" stroke-width="2.6" stroke-linejoin="round"/>',c),
  drop: (c?: string): string => svg('0 0 24 30','<path d="M12 2 C16 10 22 15 22 20 A10 10 0 0 1 2 20 C2 15 8 10 12 2 Z" fill="'+O+'" stroke="'+K+'" stroke-width="2.4" stroke-linejoin="round"/>',c),
};

export type BrandIconName = keyof typeof BRAND_ICONS;
