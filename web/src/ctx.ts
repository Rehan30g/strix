/* The context object every screen receives: mount(root, ctx) => cleanup. */
import { api } from './api';
import { player, chunker, splitChunks } from './player';
import { store, loadVoices, loadConfig, loadCharacters, refreshMe } from './store';
import { icons } from './icons';
import { settings } from './settings';
import { toast, confirmDialog, modal, drawer, popover, menuItem } from './ui/overlay';
import { h, btn, renderTagged, avatar } from './ui/dom';
import { hasSpeech, listen } from './lib/speech';

export interface RouteInfo { name: string; path: string; params: URLSearchParams }

export interface ShellApi {
  /** Set the title shown in the top bar (defaults to the route title). */
  setTitle(title: string): void;
  /** Put screen-specific controls in the top bar (left of the account button). Pass [] to clear. */
  setActions(nodes: Node[]): void;
  /** Show a back arrow left of the title (null hides it). */
  setBack(fn: (() => void) | null): void;
  /** Hide/show the top bar (screens with their own header, e.g. Chat). */
  setTopbar(visible: boolean): void;
  /** Hide/show the mobile tab bar (e.g. inside a conversation). */
  setTabbar(visible: boolean): void;
  /** Hide/show all chrome. */
  setChrome(visible: boolean): void;
  /** A round avatar button that opens the account sheet (for screens with their own header). */
  accountButton(): HTMLElement;
}

export interface ScreenCtx {
  api: typeof api;
  player: typeof player;
  store: typeof store;
  icons: typeof icons;
  settings: typeof settings;
  /** Shared data loaders (cached). */
  data: { voices: typeof loadVoices; config: typeof loadConfig; characters: typeof loadCharacters; refreshMe: typeof refreshMe };
  ui: {
    h: typeof h; btn: typeof btn; renderTagged: typeof renderTagged; avatar: typeof avatar;
    toast: typeof toast; confirm: typeof confirmDialog; modal: typeof modal; drawer: typeof drawer; popover: typeof popover; menuItem: typeof menuItem;
  };
  speech: { hasSpeech: typeof hasSpeech; listen: typeof listen };
  text: { chunker: typeof chunker; splitChunks: typeof splitChunks };
  route: RouteInfo;
  navigate(path: string): void;
  shell: ShellApi;
}

export type Cleanup = () => void;
/** A screen may return a cleanup function, or an object that also handles in-screen route changes
    (same route name, different path/query) without being re-mounted. */
export type MountResult = Cleanup | { cleanup: Cleanup; onRoute?: (r: RouteInfo) => void } | void;
export type MountFn = (root: HTMLElement, ctx: ScreenCtx) => MountResult;

export function makeCtx(route: RouteInfo, navigate: (p: string) => void, shell: ShellApi): ScreenCtx {
  return {
    api, player, store, icons, settings,
    data: { voices: loadVoices, config: loadConfig, characters: loadCharacters, refreshMe },
    ui: { h, btn, renderTagged, avatar, toast, confirm: confirmDialog, modal, drawer, popover, menuItem },
    speech: { hasSpeech, listen },
    text: { chunker, splitChunks },
    route, navigate, shell,
  };
}
