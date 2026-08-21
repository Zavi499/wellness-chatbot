<?php
/**
 * Brand palette — the single source of truth for the widget and admin theme.
 *
 * Matches the ramp already used by the Wellness World doctor-portal plugin so
 * the chatbot does not look like a bolt-on: primary #9322AA, 10 stops.
 * Override with the `wwc_brand_palette` filter.
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_Brand {

	/** The primary brand colour (== stop 600). */
	const PRIMARY = '#9322AA';

	/**
	 * @return array<int,string>
	 */
	public static function palette() {
		return apply_filters(
			'wwc_brand_palette',
			array(
				50  => '#F8EDFA',
				100 => '#F1DDF5',
				200 => '#DEB4E7',
				300 => '#CB8AD9',
				400 => '#B25FC6',
				500 => '#A23BB6',
				600 => '#9322AA',
				700 => '#7A1C8E',
				800 => '#5C1569',
				900 => '#400F49',
			)
		);
	}

	/**
	 * @param int $stop One of the ramp keys (50..900).
	 * @return string
	 */
	public static function color( $stop ) {
		$palette = self::palette();
		return isset( $palette[ $stop ] ) ? $palette[ $stop ] : self::PRIMARY;
	}

	/**
	 * CSS custom properties for injection into a scoped style block.
	 *
	 * @return string
	 */
	public static function css_vars() {
		$out = '';
		foreach ( self::palette() as $stop => $hex ) {
			$out .= "--wwc-{$stop}:{$hex};";
		}
		$out .= '--wwc-primary:' . self::color( 600 ) . ';';
		$out .= '--wwc-primary-hover:' . self::color( 700 ) . ';';
		$out .= '--wwc-primary-text:' . self::color( 800 ) . ';';
		$out .= '--wwc-surface:' . self::color( 50 ) . ';';
		// "r, g, b" triplet, for CSS that needs an alpha channel (rgba()) a
		// plain hex custom property can't provide — e.g. the launcher's pulse.
		$out .= '--wwc-primary-rgb:' . self::hex_to_rgb( self::color( 600 ) ) . ';';
		return $out;
	}

	/**
	 * @param string $hex e.g. '#9322AA'.
	 * @return string e.g. '147, 34, 170'.
	 */
	private static function hex_to_rgb( $hex ) {
		$hex = ltrim( $hex, '#' );
		if ( 3 === strlen( $hex ) ) {
			$hex = $hex[0] . $hex[0] . $hex[1] . $hex[1] . $hex[2] . $hex[2];
		}
		$r = hexdec( substr( $hex, 0, 2 ) );
		$g = hexdec( substr( $hex, 2, 2 ) );
		$b = hexdec( substr( $hex, 4, 2 ) );
		return "{$r}, {$g}, {$b}";
	}
}
