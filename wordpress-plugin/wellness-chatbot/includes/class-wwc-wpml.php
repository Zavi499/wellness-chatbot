<?php
/**
 * WPML product-translation lookups.
 *
 * WPML doesn't attach a translation to a product — it creates a SECOND,
 * independent WooCommerce product post per language, linked via a
 * translation group. Every product sync entry point needs to collapse that
 * pair back down to one canonical id (the English/original post) before it
 * ever reaches the backend, which has no concept of "this post is a
 * translation of that post."
 *
 * Every method here is a safe no-op when WPML isn't active, so a site
 * without WPML sees zero behaviour change.
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_Wpml {

	/**
	 * The English/original post id for any post in the same translation
	 * group — including the id itself, on a non-WPML site or a post that IS
	 * already the original.
	 *
	 * @param int $post_id Any product post id (original or a translation).
	 * @return int
	 */
	public static function canonical_id( $post_id ) {
		if ( 'wpml' !== WWC_Meta::uses_multilingual_plugin() ) {
			return (int) $post_id;
		}
		/**
		 * `wpml_object_id( element_id, element_type, return_original_if_missing, language_code )`
		 * — asking for the 'en' translation with return_original_if_missing=true
		 * means: if this element has no 'en' translation (shouldn't happen for
		 * an English-original catalogue), fall back to the element itself
		 * rather than returning null.
		 */
		$id = apply_filters( 'wpml_object_id', $post_id, 'product', true, 'en' );
		return $id ? (int) $id : (int) $post_id;
	}

	/**
	 * The sibling post id for a canonical product in another language, or
	 * null if that translation doesn't exist (or WPML isn't active).
	 *
	 * @param int    $canonical_id The English/original post id.
	 * @param string $lang         Target language code, e.g. 'ar'.
	 * @return int|null
	 */
	public static function translation_id( $canonical_id, $lang ) {
		if ( 'wpml' !== WWC_Meta::uses_multilingual_plugin() ) {
			return null;
		}
		$id = apply_filters( 'wpml_object_id', $canonical_id, 'product', false, $lang );
		return $id ? (int) $id : null;
	}

	/**
	 * Whether this post is itself the canonical/original — i.e. NOT a
	 * translation of some other post.
	 *
	 * @param int $post_id Product post id.
	 * @return bool
	 */
	public static function is_canonical( $post_id ) {
		return (int) $post_id === self::canonical_id( $post_id );
	}
}
