import type { CSSProperties } from "react";
import {
  type LucideIcon,
  Apple,
  Baby,
  Banknote,
  Bed,
  Beer,
  Bike,
  BookOpen,
  Briefcase,
  Building2,
  Bus,
  Cake,
  Calendar,
  Camera,
  Car,
  CarFront,
  Cat,
  Church,
  CircleDollarSign,
  Clapperboard,
  Clock,
  Coffee,
  Coins,
  Cpu,
  CreditCard,
  Dices,
  Dog,
  DollarSign,
  Droplet,
  Dumbbell,
  Film,
  Flame,
  Flower2,
  Folder,
  Fuel,
  Gamepad2,
  Gem,
  Gift,
  Glasses,
  Globe,
  GraduationCap,
  Guitar,
  Hammer,
  HandHeart,
  Headphones,
  Heart,
  HeartPulse,
  Home,
  Hospital,
  Key,
  Lamp,
  Landmark,
  Laptop,
  Layers,
  Lightbulb,
  Mail,
  MapPin,
  Mountain,
  Music,
  Package,
  Paintbrush,
  PartyPopper,
  PawPrint,
  Percent,
  Phone,
  PiggyBank,
  Pill,
  Pizza,
  Plane,
  Plug,
  Popcorn,
  Receipt,
  Recycle,
  Repeat,
  Sandwich,
  Scale,
  School,
  Scissors,
  Shield,
  Ship,
  Shirt,
  ShoppingBag,
  ShoppingCart,
  Smartphone,
  Sofa,
  Sparkles,
  SquareParking,
  Stethoscope,
  Syringe,
  Tag,
  Tags,
  Tent,
  Ticket,
  TrainFront,
  Trees,
  TrendingUp,
  Truck,
  Tv,
  Umbrella,
  User,
  Utensils,
  Wallet,
  Watch,
  Wifi,
  Wine,
  Wrench,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface CategoryIconProps {
  /** Kebab-case lucide icon name (e.g. "utensils"). Falls back to a generic Tag when null/unknown. */
  name: string | null | undefined;
  size?: number;
  className?: string;
}

/**
 * Static map of the icon names a category or group can use to their lucide
 * components. The seed writes a subset of these and the category manager's
 * icon picker offers all of them. A bounded static map avoids lucide's
 * dynamic-import manifest (~1,500 entries) and the per-icon fetch waterfall,
 * and renders on the server. Unknown names fall back to Tag.
 */
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  banknote: Banknote,
  car: Car,
  "car-front": CarFront,
  "circle-dollar-sign": CircleDollarSign,
  clapperboard: Clapperboard,
  coffee: Coffee,
  cpu: Cpu,
  "dollar-sign": DollarSign,
  droplet: Droplet,
  dumbbell: Dumbbell,
  fuel: Fuel,
  gift: Gift,
  "graduation-cap": GraduationCap,
  heart: Heart,
  "heart-pulse": HeartPulse,
  home: Home,
  key: Key,
  lamp: Lamp,
  landmark: Landmark,
  laptop: Laptop,
  pill: Pill,
  plane: Plane,
  repeat: Repeat,
  shirt: Shirt,
  "shopping-bag": ShoppingBag,
  "shopping-cart": ShoppingCart,
  smartphone: Smartphone,
  "square-parking": SquareParking,
  stethoscope: Stethoscope,
  "train-front": TrainFront,
  "trending-up": TrendingUp,
  umbrella: Umbrella,
  user: User,
  utensils: Utensils,
  wifi: Wifi,
  wrench: Wrench,
  zap: Zap,
  baby: Baby,
  sparkles: Sparkles,
  music: Music,
  guitar: Guitar,
  "piggy-bank": PiggyBank,
  briefcase: Briefcase,
  "book-open": BookOpen,
  church: Church,
  "hand-heart": HandHeart,
  scissors: Scissors,
  "paw-print": PawPrint,
  film: Film,
  "gamepad-2": Gamepad2,
  tv: Tv,
  popcorn: Popcorn,
  pizza: Pizza,
  beer: Beer,
  wine: Wine,
  sandwich: Sandwich,
  apple: Apple,
  bus: Bus,
  bike: Bike,
  ship: Ship,
  tent: Tent,
  mountain: Mountain,
  hammer: Hammer,
  paintbrush: Paintbrush,
  plug: Plug,
  flame: Flame,
  lightbulb: Lightbulb,
  phone: Phone,
  mail: Mail,
  receipt: Receipt,
  "credit-card": CreditCard,
  wallet: Wallet,
  coins: Coins,
  percent: Percent,
  scale: Scale,
  shield: Shield,
  tag: Tag,
  tags: Tags,
  ticket: Ticket,
  calendar: Calendar,
  clock: Clock,
  "map-pin": MapPin,
  globe: Globe,
  camera: Camera,
  headphones: Headphones,
  dices: Dices,
  hospital: Hospital,
  syringe: Syringe,
  glasses: Glasses,
  bed: Bed,
  sofa: Sofa,
  trees: Trees,
  "flower-2": Flower2,
  recycle: Recycle,
  truck: Truck,
  package: Package,
  "building-2": Building2,
  school: School,
  dog: Dog,
  cat: Cat,
  cake: Cake,
  "party-popper": PartyPopper,
  gem: Gem,
  watch: Watch,
  folder: Folder,
  layers: Layers,
};

/** Every icon name the picker offers, in display order. */
export const CATEGORY_ICON_NAMES: readonly string[] = Object.keys(CATEGORY_ICONS);

/**
 * Renders a category or category-group icon from its stored lucide name,
 * falling back to a generic Tag for missing or unrecognized names.
 */
export function CategoryIcon({ name, size = 16, className }: CategoryIconProps) {
  const Icon = (name && CATEGORY_ICONS[name]) || Tag;
  return <Icon size={size} className={className} />;
}

interface CategoryIconTileProps {
  name: string | null | undefined;
  /** Pixel size of the glyph inside the tile. */
  iconSize?: number;
  /** Merged onto the base tile classes — pass `size-*` to override the default tile size. */
  className?: string;
  style?: CSSProperties;
}

/**
 * A CategoryIcon rendered inside the standard muted rounded tile used across
 * report and dashboard tables. Defaults to a size-8 tile; pass `className`
 * (e.g. "size-6") to resize and `style` to tint (e.g. chart-colored rows).
 */
export function CategoryIconTile({
  name,
  iconSize = 16,
  className,
  style,
}: CategoryIconTileProps) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
        className,
      )}
      style={style}
    >
      <CategoryIcon name={name} size={iconSize} />
    </span>
  );
}
