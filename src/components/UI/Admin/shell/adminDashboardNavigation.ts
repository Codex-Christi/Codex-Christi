import {
  ClipboardList,
  DatabaseZap,
  Home,
  RotateCcw,
  ScrollText,
  Settings,
  ShoppingBag,
  Store,
  Webhook,
} from 'lucide-react';
import type {
  AdminDashboardAccess,
  AdminDashboardNavigationGroup,
  AdminDashboardNavigationItem,
  AdminDashboardPageConfig,
} from './adminDashboardTypes';

export const adminDashboardNavigationGroups: AdminDashboardNavigationGroup[] = [
  {
    id: 'core',
    label: 'Core',
    items: [
      {
        title: 'Admin Dashboard',
        description: 'Main admin hub',
        href: '/admin',
        icon: Home,
        section: 'admin',
      },
    ],
  },
  {
    id: 'shop',
    label: 'Shop Ops',
    items: [
      {
        title: 'Shop Overview',
        description: 'Payments, recovery, fulfillment, and catalog',
        href: '/admin/shop',
        icon: ShoppingBag,
        requiredAccess: 'canAccessShopOverview',
        section: 'shop',
      },
      {
        title: 'Paid Order Recovery',
        description: 'Recover paid checkout rows',
        href: '/admin/shop/paid-order-recovery',
        icon: ClipboardList,
        requiredAccess: 'canAccessShopTools',
        section: 'shop-paid-order-recovery',
      },
      {
        title: 'Reconciliation',
        description: 'PayPal truth checks',
        href: '/admin/shop/paypal-reconciliation',
        icon: RotateCcw,
        requiredAccess: 'canAccessShopTools',
        section: 'shop-payment-reconciliation',
      },
      {
        title: 'PayPal Webhooks',
        description: 'Ledger webhook trust bindings',
        href: '/admin/shop/paypal-webhooks',
        icon: Webhook,
        requiredAccess: 'canAccessShopTools',
        section: 'shop-paypal-webhooks',
      },
      {
        title: 'Storefront Data Health',
        description: 'Catalog, snapshots, and SEO metadata',
        href: '/admin/shop/storefront-data-health',
        icon: Store,
        requiredAccess: 'canAccessShopTools',
        section: 'shop-storefront-data-health',
      },
    ],
  },
  {
    id: 'admin-ops',
    label: 'Admin Ops',
    items: [
      {
        title: 'Admin Ops',
        description: 'Admin users, scopes, and transfers',
        href: '/admin/admin-ops',
        icon: Settings,
        requiredAccess: 'canAccessAdminOps',
        section: 'admin-ops',
      },
      {
        title: 'Notification Recipients',
        description: 'Operational email routing',
        href: '/admin/admin-ops/notification-recipients',
        icon: DatabaseZap,
        requiredAccess: 'canAccessAdminOps',
        section: 'admin-notification-recipients',
      },
      {
        title: 'Security Records',
        description: 'Activity and retention cleanup',
        href: '/admin/admin-ops/security-records',
        icon: ScrollText,
        requiredAccess: 'canAccessAuditLogs',
        section: 'admin-security-records',
      },
    ],
  },
];

const defaultPageConfig: AdminDashboardPageConfig = {
  section: 'admin',
  title: 'Admin Dashboard',
  subtitle: 'Operational overview across Codex Christi admin tools',
  searchPlaceholder: 'Search admin tools, orders, audit logs, recipients...',
};

const pageConfigs: Array<[prefix: string, config: AdminDashboardPageConfig]> = [
  [
    '/admin/shop/paid-order-recovery/',
    {
      section: 'shop-paid-order-recovery',
      title: 'Paid Order Recovery Detail',
      subtitle: 'Inspect timeline, provider state, failure context, and recovery actions',
      searchPlaceholder: 'Search order tokens, support refs, customers...',
    },
  ],
  [
    '/admin/shop/paid-order-recovery',
    {
      section: 'shop-paid-order-recovery',
      title: 'Paid Order Recovery',
      subtitle: 'Provider-neutral queue for paid, paused, failed, and recoverable orders',
      searchPlaceholder: 'Search order tokens, customers, support refs...',
    },
  ],
  [
    '/admin/shop/paypal-reconciliation',
    {
      section: 'shop-payment-reconciliation',
      title: 'PayPal Reconciliation',
      subtitle: 'Payment truth checks before fulfillment recovery',
      searchPlaceholder: 'Search PayPal order tokens, capture IDs, customers...',
    },
  ],
  [
    '/admin/shop/paypal-webhooks',
    {
      section: 'shop-paypal-webhooks',
      title: 'PayPal Ledger Webhooks',
      subtitle: 'Env and DB trust bindings for ledger transaction webhook verification',
      searchPlaceholder: 'Search webhook IDs, env variables, targets...',
    },
  ],
  [
    '/admin/shop/storefront-data-health/variant-publication-issues',
    {
      section: 'shop-storefront-data-health',
      title: 'Variant Publication Issues',
      subtitle: 'Manual repair queue and supplier evidence for unsafe storefront variants',
      searchPlaceholder: 'Search product IDs, variant IDs, SKUs, issue evidence...',
    },
  ],
  [
    '/admin/shop/storefront-data-health',
    {
      section: 'shop-storefront-data-health',
      title: 'Storefront Data Health',
      subtitle: 'Merchize catalog, storefront snapshots, and SEO metadata coverage',
      searchPlaceholder: 'Search SKUs, product titles, catalog records...',
    },
  ],
  [
    '/admin/shop',
    {
      section: 'shop',
      title: 'Shop Operations',
      subtitle: 'Payments, recovery, fulfillment, and shop support tooling',
      searchPlaceholder: 'Search orders, support refs, customers...',
    },
  ],
  [
    '/admin/admin-ops/notification-recipients',
    {
      section: 'admin-notification-recipients',
      title: 'Notification Recipients',
      subtitle: 'Default recipients and per-group notification routing',
      searchPlaceholder: 'Search recipient emails, groups, admin names...',
    },
  ],
  [
    '/admin/admin-ops/security-records',
    {
      section: 'admin-security-records',
      title: 'Admin Security Records',
      subtitle: 'Admin activity and security record maintenance',
      searchPlaceholder: 'Search actions, actor IDs, targets, records...',
    },
  ],
  [
    '/admin/admin-ops',
    {
      section: 'admin-ops',
      title: 'Admin Operations',
      subtitle: 'Operational admin access, scopes, recipients, and master-admin transfer',
      searchPlaceholder: 'Search admin users, scopes, notification groups...',
    },
  ],
];

export function getAdminDashboardPageConfig(pathname: string | null): AdminDashboardPageConfig {
  if (!pathname) return defaultPageConfig;

  return pageConfigs.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? defaultPageConfig;
}

export function getPermittedAdminNavigationGroups(access: AdminDashboardAccess) {
  return adminDashboardNavigationGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => canShowNavigationItem(item, access)),
    }))
    .filter((group) => group.items.length > 0);
}

function canShowNavigationItem(item: AdminDashboardNavigationItem, access: AdminDashboardAccess) {
  return item.requiredAccess ? access[item.requiredAccess] : true;
}
