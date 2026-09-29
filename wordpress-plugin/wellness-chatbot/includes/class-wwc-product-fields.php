<?php
/**
 * The store's own "Ingredients" and "How to use" custom fields (ACF).
 *
 * These two fields are some of the best evidence there is for labelling a
 * product accurately, and until now they never left WordPress. Which ACF
 * field holds which is configurable on the Settings screen; until someone
 * chooses, the field is auto-detected by its label ("Ingredients",
 * "How to use", "Directions" …).
 *
 * Works without ACF too: a field name is then read as a plain post meta key.
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_Product_Fields {

	const OPTION_INGREDIENTS = 'wwc_field_ingredients';
	const OPTION_HOW_TO_USE  = 'wwc_field_how_to_use';

	/** Sentinel stored when the admin explicitly chose "none" — distinct from "not chosen yet". */
	const NONE = '__none__';

	/**
	 * Label patterns used to auto-detect each field before an admin chooses.
	 *
	 * @return array<string,string>
	 */
	private static function patterns() {
		return array(
			'ingredients' => '/ingredient|inci|composition|مكونات|المكونات/i',
			'how_to_use'  => '/how\s*to\s*use|usage|direction|application|طريقة\s*الاستخدام|الاستعمال/i',
		);
	}

	/**
	 * ACF fields attached to products, as name => label. Empty without ACF.
	 *
	 * @return array<string,string>
	 */
	public static function acf_fields() {
		static $cache = null;
		if ( null !== $cache ) {
			return $cache;
		}
		$cache = array();
		if ( ! function_exists( 'acf_get_field_groups' ) || ! function_exists( 'acf_get_fields' ) ) {
			return $cache;
		}
		foreach ( acf_get_field_groups( array( 'post_type' => 'product' ) ) as $group ) {
			$fields = acf_get_fields( $group );
			if ( ! is_array( $fields ) ) {
				continue;
			}
			foreach ( $fields as $field ) {
				if ( empty( $field['name'] ) ) {
					continue;
				}
				// Layout-only field types hold no value of their own.
				if ( isset( $field['type'] ) && in_array( $field['type'], array( 'tab', 'message', 'accordion' ), true ) ) {
					continue;
				}
				$label                    = isset( $field['label'] ) && '' !== $field['label'] ? $field['label'] : $field['name'];
				$cache[ $field['name'] ] = $label;
			}
		}
		return $cache;
	}

	/**
	 * The field name to read for 'ingredients' or 'how_to_use', or '' for none.
	 *
	 * @param string $which 'ingredients' | 'how_to_use'.
	 * @return string
	 */
	public static function field_name( $which ) {
		$option = 'ingredients' === $which ? self::OPTION_INGREDIENTS : self::OPTION_HOW_TO_USE;
		$stored = (string) get_option( $option, '' );
		if ( self::NONE === $stored ) {
			return '';
		}
		if ( '' !== $stored ) {
			return $stored;
		}
		return self::detect( $which );
	}

	/**
	 * Whether the admin has confirmed a choice (vs. relying on detection).
	 *
	 * @param string $which Field key.
	 * @return bool
	 */
	public static function is_confirmed( $which ) {
		$option = 'ingredients' === $which ? self::OPTION_INGREDIENTS : self::OPTION_HOW_TO_USE;
		return '' !== (string) get_option( $option, '' );
	}

	/**
	 * Best guess from the ACF field labels and names.
	 *
	 * @param string $which Field key.
	 * @return string
	 */
	public static function detect( $which ) {
		$patterns = self::patterns();
		if ( ! isset( $patterns[ $which ] ) ) {
			return '';
		}
		foreach ( self::acf_fields() as $name => $label ) {
			if ( preg_match( $patterns[ $which ], $label ) || preg_match( $patterns[ $which ], str_replace( '_', ' ', $name ) ) ) {
				return $name;
			}
		}
		return '';
	}

	/**
	 * Reads one field for one product as plain text (HTML is stripped later by
	 * the backend). Null when no field is configured; '' when it is empty.
	 *
	 * @param int    $product_id Product post id.
	 * @param string $which      Field key.
	 * @return string|null
	 */
	public static function read( $product_id, $which ) {
		$name = self::field_name( $which );
		if ( '' === $name ) {
			return null;
		}
		// Unformatted ($format_value = false): the stored value, without ACF
		// wrapping it in markup or turning an ID into an object.
		$value = function_exists( 'get_field' )
			? get_field( $name, $product_id, false )
			: get_post_meta( $product_id, $name, true );

		return self::to_text( $value );
	}

	/**
	 * @param mixed $value Raw field value.
	 * @return string
	 */
	private static function to_text( $value ) {
		if ( null === $value || false === $value ) {
			return '';
		}
		if ( is_array( $value ) ) {
			$parts = array();
			array_walk_recursive(
				$value,
				function ( $item ) use ( &$parts ) {
					if ( is_scalar( $item ) && '' !== trim( (string) $item ) ) {
						$parts[] = trim( (string) $item );
					}
				}
			);
			return implode( "\n", $parts );
		}
		return trim( (string) $value );
	}

	/**
	 * A short real value from any product, so the admin can see they picked
	 * the right field.
	 *
	 * @param string $name Field name.
	 * @return string
	 */
	public static function sample( $name ) {
		if ( '' === $name ) {
			return '';
		}
		$ids = get_posts(
			array(
				'post_type'        => 'product',
				'post_status'      => 'publish',
				'posts_per_page'   => 1,
				'fields'           => 'ids',
				'suppress_filters' => true,
				'meta_query'       => array( // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_query
					array(
						'key'     => $name,
						'value'   => '',
						'compare' => '!=',
					),
				),
			)
		);
		if ( empty( $ids ) ) {
			return '';
		}
		$text = wp_strip_all_tags( self::to_text( function_exists( 'get_field' ) ? get_field( $name, $ids[0], false ) : get_post_meta( $ids[0], $name, true ) ) );
		return function_exists( 'mb_substr' ) ? mb_substr( $text, 0, 140 ) : substr( $text, 0, 140 );
	}
}
