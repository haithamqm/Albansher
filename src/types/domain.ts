/** الأنواع النطاقية (Domain Types) المشتركة بين الوحدات. مصدر الحقيقة لشكل الكيانات. */

export type Role = 'CUSTOMER' | 'PROVIDER' | 'ADMIN';
export type AdminLevel = 'SUPER_ADMIN' | 'ADMIN' | 'SUPPORT';
export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETED';
export type Locale = 'ar' | 'en';
export type ProviderType = 'INDIVIDUAL' | 'TECHNICIAN' | 'DRIVER' | 'WORKER' | 'COMPANY';
export type VerificationStatus = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED';
export type PricingType = 'FIXED' | 'QUOTE';
export type Priority = 'LOW' | 'NORMAL' | 'URGENT';
export type OrderStatus = 'PENDING' | 'SEARCHING' | 'ASSIGNED' | 'ACCEPTED' | 'ON_THE_WAY' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'DISPUTED';
export type ActorRole = 'CUSTOMER' | 'PROVIDER' | 'ADMIN' | 'SYSTEM';
export type AssignmentStatus = 'OFFERED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'WITHDRAWN';
export type QuoteStatus = 'SUBMITTED' | 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN' | 'EXPIRED';
export type ComplaintStatus = 'OPEN' | 'PROVIDER_REPLIED' | 'UNDER_REVIEW' | 'RESOLVED' | 'REJECTED' | 'CLOSED';
export type ComplaintCategory = 'QUALITY' | 'BEHAVIOR' | 'PRICE' | 'NO_SHOW' | 'DAMAGE' | 'OTHER';
export type ResolutionAction = 'RESTORE_COMPLETED' | 'CANCEL_ORDER' | 'WARN_PROVIDER' | 'SUSPEND_PROVIDER' | 'DISMISS';

export interface I18nText { ar: string; en?: string }

/** المستخدم المصادَق عليه في الطلب الحالي (يُشتق من التوكن + قاعدة البيانات في كل طلب). */
export interface AuthUser {
  id: string; fullName: string; phone: string; email: string | null; role: Role; locale: Locale;
  adminLevel: AdminLevel | null; providerId: string | null; avatarFileId: string | null;
}

// ===== صفوف قاعدة البيانات الخام (SQLite الآن؛ نفس الأعمدة تصلح لـPostgreSQL لاحقًا) =====
export interface UserRow {
  id: string; role_id: number; full_name: string; phone: string; email: string | null; password_hash: string;
  status: UserStatus; locale: Locale; avatar_file_id: string | null; token_version: number; last_login_at: string | null;
  created_at: string; updated_at: string; role: Role; admin_level: AdminLevel | null;
}
export interface ServiceProviderRow {
  id: string; user_id: string; provider_type: ProviderType; display_name: string; bio: string | null; company_name: string | null;
  verification_status: VerificationStatus; verified_at: string | null; verified_by: string | null; rejection_reason: string | null;
  suspension_reason: string | null; specialty: string | null; is_online: 0 | 1; base_lat: number | null; base_lng: number | null;
  rating_sum: number; rating_count: number; rating_avg: number; completed_orders_count: number; created_at: string; updated_at: string;
}
export interface CategoryRow {
  id: string; parent_id: string | null; slug: string; name_i18n: string; description_i18n: string | null; icon: string | null;
  keywords: string; module_type: string; sort_order: number; is_active: 0 | 1; created_at: string; updated_at: string;
}
export interface ServiceRow {
  id: string; category_id: string; slug: string; name_i18n: string; description_i18n: string | null; icon: string | null;
  keywords: string; pricing_type: PricingType; base_price: number | null; form_schema: string; cancellation_policy_id: string | null;
  default_priority: Priority; delivery_proof_type: 'NONE' | 'PIN' | 'RECIPIENT_CONFIRMATION' | 'PHOTO'; seasonal_enabled: 0 | 1; season_start_at: string | null; season_end_at: string | null; requires_inspection: 0 | 1; requires_vehicle: 0 | 1; supports_waiting: 0 | 1; sort_order: number; is_active: 0 | 1; created_at: string; updated_at: string;
}
export type LocalityType = 'COUNTRY' | 'GOVERNORATE' | 'CITY' | 'DISTRICT' | 'DIRECTORATE' | 'ISOLATION' | 'VILLAGE' | 'NEIGHBORHOOD';
export interface ServiceAreaRow {
  id: string; parent_id: string | null; name_i18n: string; type: 'COUNTRY' | 'CITY' | 'DISTRICT'; locality_type: LocalityType;
  center_lat: number; center_lng: number; radius_km: number; is_active: 0 | 1; created_at: string; updated_at: string;
}
export interface LocationRow {
  id: string; lat: number; lng: number; accuracy_m: number | null; address_text: string | null; landmark_text: string | null; locality_text: string | null; access_notes: string | null; area_id: string | null; source: string; created_at: string;
}
export interface OrderRow {
  id: string; code: string; customer_id: string; service_id: string; provider_id: string | null; status: OrderStatus; priority: Priority;
  description: string; form_data: string; location_id: string; location_provided: 0 | 1; area_id: string | null; contact_phone: string; scheduled_at: string | null;
  pricing_type: PricingType; price_snapshot: number | null; agreed_price: number | null; currency: string; payment_method: string;
  customer_notes: string | null; attachments: string; cancelled_by_role: string | null; cancel_reason: string | null; cancellation_fee: number | null;
  wave: number; accepted_at: string | null; started_at: string | null; completed_at: string | null; cancelled_at: string | null;
  version: number; commission_rate_snapshot: number | null; commission_amount: number | null; provider_payout_amount: number | null; settlement_status: 'NOT_APPLICABLE'|'DUE'|'PAID'|'WAIVED'; completed_by: string | null; recipient_name: string | null; recipient_phone: string | null; recipient_user_id: string | null; delivery_pin_hash: string | null; idempotency_key: string | null; created_at: string; updated_at: string;
}
export interface OrderAssignmentRow {
  id: string; order_id: string; provider_id: string; status: AssignmentStatus; wave: number; score: number | null; distance_km: number | null;
  offered_at: string; expires_at: string; responded_at: string | null;
}
export interface QuoteRow {
  id: string; order_id: string; provider_id: string; amount: number; message: string | null; valid_until: string | null;
  status: QuoteStatus; created_at: string; updated_at: string;
}
export interface RatingRow { id: string; order_id: string; customer_id: string; provider_id: string; score: number; created_at: string }
export interface ComplaintRow {
  id: string; code: string; order_id: string; opened_by: string; against_user_id: string | null; category: ComplaintCategory;
  description: string; status: ComplaintStatus; resolution_action: ResolutionAction | null; resolution_note: string | null;
  resolved_by: string | null; resolved_at: string | null; created_at: string; updated_at: string;
}
