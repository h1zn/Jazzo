package com.realabs.kipsgemrush;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.view.View;

import java.util.Locale;

/**
 * What the app shows from its first frame until the game's page has drawn
 * its own loading screen (index.html's #loading): the same picture, drawn
 * here, so there is no black screen while the WebView starts up and the
 * one hands over to the other without a jump. The page's bar then fills as
 * the game loads; this one is the same bar, still empty.
 *
 * The measures are the page's (style.css, #loading), in dp for its CSS px.
 */
final class LoadingView extends View {
    private static final int NIGHT = 0xFF0B0716;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF rect = new RectF();
    private final Typeface black = Typeface.create("sans-serif-black", Typeface.NORMAL);
    private final String word;

    LoadingView(Context context) {
        super(context);
        word = context.getString(R.string.loading).toUpperCase(Locale.getDefault());
        setClickable(true);         // touches stop here until the game is up
    }

    private static float clamp(float lo, float v, float hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    @Override
    protected void onDraw(Canvas canvas) {
        float w = getWidth();
        float h = getHeight();
        float d = getResources().getDisplayMetrics().density;
        if (w <= 0 || h <= 0) return;

        // The backdrop: night, lighter round a point a little above the middle.
        canvas.drawColor(NIGHT);
        paint.reset();
        paint.setAntiAlias(true);
        paint.setShader(new RadialGradient(0, 0, 1, 0xFF24104E, NIGHT, Shader.TileMode.CLAMP));
        canvas.save();
        canvas.translate(w / 2, h * 0.42f);
        canvas.scale(0.495f * w, 0.574f * h);
        canvas.drawPaint(paint);
        canvas.restore();
        paint.setShader(null);

        float vh = h / d;
        float vw = w / d;
        float nameSize = clamp(40, 0.14f * vh, 96) * d;
        float gap = clamp(10, 0.03f * vh, 22) * d;
        float barW = (Math.min(0.6f * vw, 340) + 4) * d;
        float barH = 16 * d;
        float wordSize = 13 * d;
        float wordLine = wordSize * 1.17f;
        float top = (h - (nameSize + gap + barH + gap + wordLine)) / 2;

        // The name, gold from light to deep, on its own dark edge.
        paint.setTypeface(black);
        paint.setTextAlign(Paint.Align.CENTER);
        paint.setTextSize(nameSize);
        paint.setLetterSpacing(0.06f);
        Paint.FontMetrics fm = paint.getFontMetrics();
        float base = top + nameSize / 2 - (fm.ascent + fm.descent) / 2;
        paint.setColor(0xFF1A0B1E);
        canvas.drawText("JAZZO", w / 2, base + 0.05f * nameSize, paint);
        paint.setColor(0xFFFFD54A);
        paint.setShader(new LinearGradient(0, top + 0.12f * nameSize, 0, top + 0.88f * nameSize, 0xFFFFF6C0, 0xFFFFB02E, Shader.TileMode.CLAMP));
        canvas.drawText("JAZZO", w / 2, base, paint);
        paint.setShader(null);

        // The bar: empty yet.
        float by = top + nameSize + gap;
        float line = 2 * d;
        rect.set(w / 2 - barW / 2 + line / 2, by + line / 2, w / 2 + barW / 2 - line / 2, by + barH - line / 2);
        paint.setStyle(Paint.Style.FILL);
        paint.setColor(0xE60C061E);
        canvas.drawRoundRect(rect, 7 * d, 7 * d, paint);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(line);
        paint.setColor(0xD9FFD65A);
        canvas.drawRoundRect(rect, 7 * d, 7 * d, paint);
        paint.setStyle(Paint.Style.FILL);

        // "Loading", in the phone's language.
        paint.setTextSize(wordSize);
        paint.setLetterSpacing(0.18f);
        paint.setColor(0xFFC8B8E8);
        fm = paint.getFontMetrics();
        canvas.drawText(word, w / 2, by + barH + gap + wordLine / 2 - (fm.ascent + fm.descent) / 2, paint);
    }
}
