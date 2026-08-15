<?php
/**
 * The `_wwc_*` product meta schema (spec §3.2).
 *
 * WooCommerce stays the system of record, so the extended fields live as post
 * meta on the `product` post type. `_wwc_verification_status` is registered
 * with an auth callback that requires the general catalogue-manage capability
 * to write it — pharmacist review (`_wwc_requires_pharmacist_review`) is
 * informational only and never restricts who may verify a product.
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_Meta {

	const STATUS_VERIFIED   = 'verified';
	const STATUS_PARTIAL    = 'partial';
	const STATUS_UNVERIFIED = 'unverified';
	const STATUS_NEEDS_RX   = 'needs_pharmacist_review';

	/**
	 * Meta key => type. Bilingual fields are stored as `_en` / `_ar` pairs
	 * unless a multilingual plugin is active (see `uses_multilingual_plugin`).
	 *
	 * @return array<string,string>
	 */
	public static function schema() {
		return array(
			'_wwc_verification_status'       => 'string',
			'_wwc_ai_generated'              => 'boolean',
			'_wwc_ai_confidence'             => 'number',
			'_wwc_requires_pharmacist_review'=> 'boolean',
			'_wwc_verified_by_pharmacist'    => 'boolean',
			'_wwc_concern_primary_en'        => 'array',
			'_wwc_concern_primary_ar'        => 'array',
			'_wwc_concern_secondary_en'      => 'array',
			'_wwc_concern_secondary_ar'      => 'array',
			'_wwc_suitable_types_en'         => 'array',
			'_wwc_suitable_types_ar'         => 'array',
			'_wwc_not_ideal_for_en'          => 'string',
			'_wwc_not_ideal_for_ar'          => 'string',
			'_wwc_key_ingredients'           => 'array',
			'_wwc_full_ingredients'          => 'string',
			'_wwc_texture_finish_en'         => 'string',
			'_wwc_texture_finish_ar'         => 'string',
			'_wwc_fragrance'                 => 'string',
			'_wwc_fragrance_type'            => 'string',
			'_wwc_alcohol'                   => 'string',
			'_wwc_alcohol_type'              => 'string',
			'_wwc_how_to_use_en'             => 'string',
			'_wwc_how_to_use_ar'             => 'string',
			'_wwc_routine_step'              => 'string',
			'_wwc_routine_time'              => 'string',
			'_wwc_age_suitability'           => 'string',
			'_wwc_age_min'                   => 'integer',
			'_wwc_age_max'                   => 'integer',
			'_wwc_pregnancy_guidance_en'     => 'string',
			'_wwc_pregnancy_guidance_ar'     => 'string',
			'_wwc_warnings_en'               => 'string',
			'_wwc_warnings_ar'               => 'string',
			'_wwc_complementary_products'    => 'array',
			'_wwc_alternative_products'      => 'array',
			'_wwc_source_verification_date'  => 'string',
			'_wwc_source_verification_note'  => 'string',
			'_wwc_name_ar'                   => 'string',
			'_wwc_synonyms_en'               => 'array',
			'_wwc_synonyms_ar'               => 'array',
		);
	}

	public static function init() {
		add_action( 'init', array( __CLASS__, 'register_meta' ) );
	}

	public static function register_meta() {
		foreach ( self::schema() as $key => $type ) {
			register_post_meta(
				'product',
				$key,
				array(
					'type'          => 'array' === $type ? 'array' : $type,
					'single'        => true,
					'show_in_rest'  => false,
					'auth_callback' => function ( $allowed, $meta_key, $post_id ) {
						unset( $allowed );
						return self::can_edit_meta( $meta_key, $post_id );
					},
				)
			);
		}
	}

	/**
	 * Who may write a given meta key.
	 *
	 * @param string $meta_key Meta key.
	 * @param int    $post_id  Product ID.
	 * @return bool
	 */
	public static function can_edit_meta( $meta_key, $post_id ) {
		if ( ! current_user_can( 'edit_post', $post_id ) ) {
			return false;
		}
		if ( '_wwc_verification_status' === $meta_key || '_wwc_verified_by_pharmacist' === $meta_key ) {
			return self::can_verify( $post_id );
		}
		return WWC_Roles::can_manage();
	}

	/**
	 * Any user who can manage the catalogue may verify any product, including
	 * one flagged for pharmacist review (vitamins/supplements, and anything
	 * touching pregnancy/children/medicines) — pharmacist review is
	 * informational (see `requires_pharmacist_review()`), not a requirement.
	 *
	 * @param int $post_id Product ID.
	 * @return bool
	 */
	public static function can_verify( $post_id ) {
		return WWC_Roles::can_manage();
	}

	/**
	 * Whether this product touches a category the labeling pipeline flags for
	 * extra care (vitamins/supplements, pregnancy/children/medicine mentions).
	 * Purely informational — shown to the reviewer, never blocks approval.
	 *
	 * @param int $post_id Product ID.
	 * @return bool
	 */
	public static function requires_pharmacist_review( $post_id ) {
		return '1' === (string) get_post_meta( $post_id, '_wwc_requires_pharmacist_review', true );
	}

	public static function verification_status( $post_id ) {
		$status = (string) get_post_meta( $post_id, '_wwc_verification_status', true );
		return '' === $status ? self::STATUS_UNVERIFIED : $status;
	}

	/**
	 * Writes the verification status.
	 *
	 * @param int    $post_id Product ID.
	 * @param string $status  One of the STATUS_* constants.
	 * @return true|WP_Error
	 */
	public static function set_verification_status( $post_id, $status ) {
		$allowed = array( self::STATUS_VERIFIED, self::STATUS_PARTIAL, self::STATUS_UNVERIFIED, self::STATUS_NEEDS_RX );
		if ( ! in_array( $status, $allowed, true ) ) {
			return new WP_Error( 'wwc_bad_status', __( 'Unknown verification status.', 'wellness-chatbot' ) );
		}

		if ( self::STATUS_VERIFIED === $status && ! self::can_verify( $post_id ) ) {
			return new WP_Error(
				'wwc_forbidden',
				__( 'You do not have permission to verify this product.', 'wellness-chatbot' )
			);
		}

		update_post_meta( $post_id, '_wwc_verification_status', $status );
		if ( self::STATUS_VERIFIED === $status && WWC_Roles::current_user_is_pharmacist() ) {
			update_post_meta( $post_id, '_wwc_verified_by_pharmacist', '1' );
		}
		return true;
	}

	/**
	 * Detects WPML / Polylang so bilingual fields can be routed through the tool
	 * translators already use, instead of the flat `_ar` fallback (spec §3.2).
	 *
	 * @return string|false 'wpml', 'polylang', or false.
	 */
	public static function uses_multilingual_plugin() {
		if ( defined( 'ICL_SITEPRESS_VERSION' ) ) {
			return 'wpml';
		}
		if ( function_exists( 'pll_current_language' ) ) {
			return 'polylang';
		}
		return false;
	}

	/**
	 * Reads a bilingual field, preferring the active multilingual plugin's
	 * translation when one is installed.
	 *
	 * @param int    $post_id Product ID.
	 * @param string $base    Meta key without the language suffix.
	 * @param string $lang    'en' or 'ar'.
	 * @return string
	 */
	public static function bilingual( $post_id, $base, $lang ) {
		$value = (string) get_post_meta( $post_id, $base . '_' . $lang, true );
		if ( '' !== $value ) {
			return $value;
		}
		$plugin = self::uses_multilingual_plugin();
		if ( $plugin ) {
			/**
			 * Lets a site using WPML or Polylang supply the translation from the
			 * plugin's own tables rather than the `_ar` meta fallback.
			 *
			 * @param string $value   Empty string.
			 * @param int    $post_id Product ID.
			 * @param string $base    Meta key base.
			 * @param string $lang    Language code.
			 */
			return (string) apply_filters( 'wwc_bilingual_meta', '', $post_id, $base, $lang );
		}
		return '';
	}
}
