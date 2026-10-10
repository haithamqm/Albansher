export class AppError extends Error {
    status;
    code;
    details;
    retryAfter;
    constructor(status, code, message, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}
export const E = {
    badRequest: (m = 'طلب غير صالح', code = 'BAD_REQUEST', d) => new AppError(400, code, m, d),
    unauthorized: (m = 'يجب تسجيل الدخول أولًا', code = 'UNAUTHORIZED') => new AppError(401, code, m),
    forbidden: (m = 'ليست لديك صلاحية لتنفيذ هذا الإجراء', code = 'FORBIDDEN') => new AppError(403, code, m),
    notFound: (m = 'العنصر المطلوب غير موجود', code = 'NOT_FOUND') => new AppError(404, code, m),
    conflict: (m, code = 'CONFLICT') => new AppError(409, code, m),
    unprocessable: (m, code = 'UNPROCESSABLE', d) => new AppError(422, code, m, d),
    serviceUnavailable: (m = 'الخدمة غير متاحة حاليًا', code = 'SERVICE_UNAVAILABLE') => new AppError(503, code, m),
    tooMany: (retryAfterSec = 60) => {
        const e = new AppError(429, 'RATE_LIMITED', 'محاولات كثيرة، يرجى المحاولة لاحقًا');
        e.retryAfter = retryAfterSec;
        return e;
    },
};
//# sourceMappingURL=errors.js.map